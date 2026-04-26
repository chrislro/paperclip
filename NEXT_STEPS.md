# NEXT_STEPS.md

Source: `GSTACK_REVIEW.md`

## Summary

Critical issues: **0**  
High issues: **2**

## Priority actions

| Priority | Issue | Action | Estimated effort | Owner | Deadline suggestion |
|---|---|---|---:|---|---|
| P0 | High — Private Mac Mini service inventory committed | Replace `ops/mac-mini-health-collector/services.json` with sanitized `services.example.json`; ignore real `services.json`; keep Chris-specific config private. | 30-60m | Jarvis | Before any push |
| P0 | High — OpenClaw gateway drops structured Paperclip payload | Rework `execute.ts` to gate `paperclip` payload by gateway capability/version/config instead of globally discarding it. Add regression tests for legacy and Paperclip-aware gateways. | 2-4h | Jarvis | Before merge/push |
| P1 | Medium — `package-lock.json` churn in pnpm workspace | Confirm lockfile policy; remove npm lockfile changes if accidental. | 15-30m | Chris decision, Jarvis execution | Before push |
| P1 | Medium — LaunchAgent installer uses repo path as runtime path | Copy collector to Application Support or document repo path as runtime; add uninstall/dry-run mode. | 1-2h | Jarvis | Before installing elsewhere |

## Verification

Run collector once, repair local dependencies if needed, then run:

```bash
CONFIG_PATH=ops/mac-mini-health-collector/services.json OUTPUT_PATH=/tmp/paperclip-health-review.json python3 ops/mac-mini-health-collector/collector.py --once --stdout
pnpm run typecheck
```
