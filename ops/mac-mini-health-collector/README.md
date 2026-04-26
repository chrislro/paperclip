# Mac Mini Health Collector

This directory contains the Mac Mini health collector for [CHRA-319](/CHRA/issues/CHRA-319). It is a small stdlib-only Python process supervised by `launchd` that writes a JSON health snapshot every 60 seconds.

## Output Contract

The collector writes a single JSON snapshot to:

- `~/Library/Application Support/Paperclip/mac-mini-health/health-snapshot.json`

This task intentionally chose a file-on-disk contract instead of a local HTTP endpoint. The future Dashboard backend only needs a durable, machine-local snapshot that it can read or ingest, and a file keeps the collector small, removes the need to expose another port, and avoids a second long-lived server process.

## What It Collects

- UTC ISO8601 timestamp
- Host metadata
- CPU load averages (`1m`, `5m`, `15m`)
- Memory total, free, used, inactive, and compressed bytes
- Disk usage for local `/dev/*` volumes, excluding hidden Time Machine snapshot mounts
- TCP connect checks for the service inventory in `services.json`

## Service Inventory Seeded On This Host

The default config was seeded from the live listener inventory on 2026-04-18:

- `audio-to-note-api` on `127.0.0.1:8002`
- `openclaw-dashboard` on `127.0.0.1:8080`
- `openclaw-gateway` on `127.0.0.1:3334`
- `jarviscall-server` on `127.0.0.1:3001`
- `paperclip-local-api` on `127.0.0.1:3100`
- `pedbot-cloud-api` on `127.0.0.1:5050`
- `audio-to-note-cloudflared` on `127.0.0.1:20241`
- `pedbot-cloud-api-cloudflared` on `127.0.0.1:20242`
- `luxe-staging-api` on `127.0.0.1:8003`
- `luxe-staging-frontend` on `[::1]:3001`
- `open-webui` on `127.0.0.1:8088`
- `parser-dashboard` on `127.0.0.1:8501`

## Install Or Refresh

Run:

```bash
./ops/mac-mini-health-collector/install.sh
```

This writes:

- LaunchAgent plist: `~/Library/LaunchAgents/ai.paperclip.mac-mini-health-collector.plist`
- Runtime config: `~/Library/Application Support/Paperclip/mac-mini-health/services.json`
- Snapshot output: `~/Library/Application Support/Paperclip/mac-mini-health/health-snapshot.json`
- Logs:
  - `~/Library/Logs/Paperclip/ai.paperclip.mac-mini-health-collector.log`
  - `~/Library/Logs/Paperclip/ai.paperclip.mac-mini-health-collector.err.log`

## Add A New Service To Monitor

Edit the runtime config at:

- `~/Library/Application Support/Paperclip/mac-mini-health/services.json`

Each service entry needs at minimum:

```json
{
  "name": "service-name",
  "host": "127.0.0.1",
  "port": 1234
}
```

Then restart the collector:

```bash
launchctl kickstart -k "gui/$(id -u)/ai.paperclip.mac-mini-health-collector"
```

## Restart Or Disable

Restart:

```bash
launchctl kickstart -k "gui/$(id -u)/ai.paperclip.mac-mini-health-collector"
```

Disable and unload:

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/ai.paperclip.mac-mini-health-collector.plist
```

Re-enable:

```bash
./ops/mac-mini-health-collector/install.sh
```

## One-Shot Verification

To collect a single snapshot immediately:

```bash
/usr/bin/python3 ./ops/mac-mini-health-collector/collector.py --once --stdout
```
