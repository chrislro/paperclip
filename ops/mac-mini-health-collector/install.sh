#!/usr/bin/env bash

set -euo pipefail

LABEL="ai.paperclip.mac-mini-health-collector"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_SUPPORT_DIR="${HOME}/Library/Application Support/Paperclip/mac-mini-health"
LOG_DIR="${HOME}/Library/Logs/Paperclip"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
OUTPUT_PATH="${APP_SUPPORT_DIR}/health-snapshot.json"
RUNTIME_CONFIG_PATH="${APP_SUPPORT_DIR}/services.json"
SOURCE_CONFIG_PATH="${ROOT_DIR}/services.json"
SCRIPT_PATH="${ROOT_DIR}/collector.py"

mkdir -p "${APP_SUPPORT_DIR}" "${LOG_DIR}" "$(dirname "${PLIST_PATH}")"

if [[ ! -f "${RUNTIME_CONFIG_PATH}" ]]; then
  cp "${SOURCE_CONFIG_PATH}" "${RUNTIME_CONFIG_PATH}"
fi

cat >"${PLIST_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/python3</string>
      <string>${SCRIPT_PATH}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${ROOT_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>CONFIG_PATH</key>
      <string>${RUNTIME_CONFIG_PATH}</string>
      <key>OUTPUT_PATH</key>
      <string>${OUTPUT_PATH}</string>
      <key>INTERVAL_SECONDS</key>
      <string>60</string>
      <key>PATH</key>
      <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/${LABEL}.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/${LABEL}.err.log</string>
  </dict>
</plist>
PLIST

chmod 644 "${PLIST_PATH}"
plutil -lint "${PLIST_PATH}"

launchctl bootout "gui/$(id -u)" "${PLIST_PATH}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

printf 'Installed %s\n' "${LABEL}"
printf 'Output: %s\n' "${OUTPUT_PATH}"
printf 'Runtime config: %s\n' "${RUNTIME_CONFIG_PATH}"
printf 'LaunchAgent plist: %s\n' "${PLIST_PATH}"
