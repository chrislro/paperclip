#!/usr/bin/env python3

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import platform
import re
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List

DEFAULT_INTERVAL_SECONDS = 60
DEFAULT_CONFIG_PATH = Path(__file__).with_name("services.json")
DEFAULT_OUTPUT_PATH = (
    Path.home()
    / "Library"
    / "Application Support"
    / "Paperclip"
    / "mac-mini-health"
    / "health-snapshot.json"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect Mac Mini health metrics.")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Collect a single snapshot and exit.",
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Print the snapshot to stdout in addition to writing it when used with --once.",
    )
    return parser.parse_args()


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run_command(args: Iterable[str]) -> str:
    completed = subprocess.run(
        list(args),
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout


def load_services(config_path: Path) -> List[Dict[str, Any]]:
    payload = json.loads(config_path.read_text())
    services = payload.get("services", [])
    if not isinstance(services, list):
        raise ValueError("services config must contain a top-level 'services' list")
    return services


def get_host_info() -> Dict[str, Any]:
    host: Dict[str, Any] = {
        "hostname": socket.gethostname(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "python_version": platform.python_version(),
    }

    try:
        sw_vers = run_command(["sw_vers"])
    except Exception as exc:  # pragma: no cover - best effort only
        host["sw_vers_error"] = str(exc)
        return host

    for raw_line in sw_vers.splitlines():
        if ":\t" not in raw_line:
            continue
        key, value = raw_line.split(":\t", 1)
        host[key.strip().lower()] = value.strip()
    return host


def get_cpu_info() -> Dict[str, Any]:
    load_1, load_5, load_15 = os.getloadavg()
    return {
        "load_avg": {
            "1m": round(load_1, 2),
            "5m": round(load_5, 2),
            "15m": round(load_15, 2),
        },
        "cpu_count": os.cpu_count(),
    }


def get_memory_info() -> Dict[str, Any]:
    total_bytes = int(run_command(["sysctl", "-n", "hw.memsize"]).strip())
    vm_stat_output = run_command(["vm_stat"])
    page_size_match = re.search(r"page size of (\d+) bytes", vm_stat_output)
    page_size = int(page_size_match.group(1)) if page_size_match else 4096

    page_counts: Dict[str, int] = {}
    for raw_line in vm_stat_output.splitlines():
        if ":" not in raw_line:
            continue
        key, raw_value = raw_line.split(":", 1)
        normalized_key = key.strip().rstrip(".")
        digits = re.sub(r"[^0-9]", "", raw_value)
        if digits:
            page_counts[normalized_key] = int(digits)

    free_bytes = (page_counts.get("Pages free", 0) + page_counts.get("Pages speculative", 0)) * page_size
    inactive_bytes = page_counts.get("Pages inactive", 0) * page_size
    compressed_bytes = page_counts.get("Pages occupied by compressor", 0) * page_size
    used_bytes = max(total_bytes - free_bytes, 0)

    return {
        "bytes_total": total_bytes,
        "bytes_free": free_bytes,
        "bytes_used": used_bytes,
        "bytes_inactive": inactive_bytes,
        "bytes_compressed": compressed_bytes,
        "percent_used": round((used_bytes / total_bytes) * 100, 2) if total_bytes else 0.0,
    }


def get_disks() -> List[Dict[str, Any]]:
    output = run_command(["df", "-kP"])
    disks: List[Dict[str, Any]] = []
    pattern = re.compile(
        r"^(?P<filesystem>\S+)\s+"
        r"(?P<blocks>\d+)\s+"
        r"(?P<used>\d+)\s+"
        r"(?P<available>\d+)\s+"
        r"(?P<capacity>\d+%)\s+"
        r"(?P<mount>.+)$"
    )

    for raw_line in output.splitlines()[1:]:
        match = pattern.match(raw_line.strip())
        if not match:
            continue

        filesystem = match.group("filesystem")
        mount = match.group("mount")
        if not filesystem.startswith("/dev/"):
            continue
        if mount.startswith("/Volumes/.timemachine/"):
            continue

        blocks = int(match.group("blocks"))
        used = int(match.group("used"))
        available = int(match.group("available"))
        usable_blocks = used + available
        disks.append(
            {
                "filesystem": filesystem,
                "mount": mount,
                "bytes_total": usable_blocks * 1024,
                "bytes_used": used * 1024,
                "bytes_free": available * 1024,
                "percent_used": round((used / usable_blocks) * 100, 2) if usable_blocks else 0.0,
            }
        )

    return sorted(disks, key=lambda entry: entry["mount"])


def tcp_check(service: Dict[str, Any]) -> Dict[str, Any]:
    host = str(service["host"])
    port = int(service["port"])
    timeout_seconds = float(service.get("timeout_seconds", 1.5))
    started = time.perf_counter()
    reachable = False
    error_message = ""

    try:
        with socket.create_connection((host, port), timeout=timeout_seconds):
            reachable = True
    except OSError as exc:
        error_message = str(exc)

    latency_ms = round((time.perf_counter() - started) * 1000, 2)
    result = dict(service)
    result.update(
        {
            "reachable": reachable,
            "latency_ms": latency_ms,
            "error": error_message or None,
        }
    )
    return result


def build_snapshot(config_path: Path, interval_seconds: int) -> Dict[str, Any]:
    services = load_services(config_path)
    return {
        "generated_at": utc_now(),
        "collector": {
            "name": "mac-mini-health-collector",
            "version": 1,
            "interval_seconds": interval_seconds,
            "config_path": str(config_path),
            "pid": os.getpid(),
        },
        "host": get_host_info(),
        "cpu": get_cpu_info(),
        "memory": get_memory_info(),
        "disks": get_disks(),
        "services": [tcp_check(service) for service in services],
    }


def write_snapshot(snapshot: Dict[str, Any], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=str(output_path.parent),
        prefix=output_path.name,
        suffix=".tmp",
        delete=False,
    ) as handle:
        json.dump(snapshot, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
        temp_path = Path(handle.name)

    temp_path.replace(output_path)


def configure_logging() -> None:
    level_name = os.environ.get("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(message)s",
    )


def main() -> int:
    args = parse_args()
    configure_logging()

    config_path = Path(os.environ.get("CONFIG_PATH", str(DEFAULT_CONFIG_PATH))).expanduser()
    output_path = Path(os.environ.get("OUTPUT_PATH", str(DEFAULT_OUTPUT_PATH))).expanduser()
    interval_seconds = int(os.environ.get("INTERVAL_SECONDS", DEFAULT_INTERVAL_SECONDS))

    if args.once:
        snapshot = build_snapshot(config_path, interval_seconds)
        write_snapshot(snapshot, output_path)
        if args.stdout:
            json.dump(snapshot, sys.stdout, indent=2, sort_keys=True)
            sys.stdout.write("\n")
        logging.info("Wrote one-shot snapshot to %s", output_path)
        return 0

    logging.info("Starting collector loop. output=%s interval=%ss", output_path, interval_seconds)
    while True:
        started = time.monotonic()
        try:
            snapshot = build_snapshot(config_path, interval_seconds)
            write_snapshot(snapshot, output_path)
            logging.info("Snapshot written to %s", output_path)
        except Exception:
            logging.exception("Collector iteration failed")

        elapsed = time.monotonic() - started
        time.sleep(max(1.0, interval_seconds - elapsed))


if __name__ == "__main__":
    raise SystemExit(main())
