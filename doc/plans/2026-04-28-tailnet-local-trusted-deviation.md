# Local-Trusted on Tailnet: Documented Deviation

Status: Operational decision (not a product proposal)
Author: Mac Mini operator (christianoliveira)
Date: 2026-04-28
Scope: Single-host install at `mac-mini-de-chris.tail606c16.ts.net`

## 1. What This Is

This document records a deliberate deviation from the canonical deployment-mode model in `doc/DEPLOYMENT-MODES.md` for one specific Mac Mini install of Paperclip. It is **not** a proposal to change the upstream model.

## 2. The Canonical Model (Recap)

`doc/DEPLOYMENT-MODES.md` §2-3 defines three blessed configurations:

| Runtime Mode | Exposure | Auth | Use case |
|---|---|---|---|
| `local_trusted` | n/a | None (loopback-only) | Single-operator local machine |
| `authenticated` | `private` | Login required | Tailscale/VPN/LAN |
| `authenticated` | `public` | Login required | Internet-facing |

§3 explicitly states `local_trusted` is "loopback-only host binding".

## 3. The Deviation

This install runs:

- `deploymentMode: "local_trusted"` (no human auth)
- `host: "127.0.0.1"`, `port: 3100` (loopback bind, ✅ matches mode)
- A Caddy reverse proxy at `:3443` (bound to all Tailscale interfaces) forwards to `localhost:3100`
- TLS termination at Caddy via Lets Encrypt cert issued by `tailscale cert`
- `allowedHostnames` enforces Host-header validation only (not source-IP)

Effective behavior: **any device on the operators tailnet can reach Paperclip without authentication**, even though Paperclip itself only listens on loopback.

Per the canonical model, the matching documented configuration would be `authenticated + private` with `bind: tailnet` and the `/board-claim` flow (DEPLOYMENT-MODES.md §7).

## 4. Why We Deviate

| Reason | Detail |
|---|---|
| Solo operator | One human; no co-tenants on this Paperclip install |
| Fully-controlled tailnet | All tailnet peers are devices the operator personally signed in to; no shared/external members; no Tailscale ACL exceptions |
| Low-friction iPhone/laptop access | Authenticated mode requires a session per device; the tailnets identity layer is treated as the auth layer |
| Cost of migration | The board-claim flow (§7) is a one-shot, but every script and watcher (`paperclip-discord-watcher.py`, future automations) would need credentialled access |

In short: the **tailnet itself is treated as the trust boundary**, with the canonical models expectation that loopback is the trust boundary intentionally relaxed.

## 5. Threat Model Assumptions (Trip-Wires)

This deviation is only safe while **all** of the following hold. Any change should trigger a re-evaluation:

1. **Solo tailnet** — no other humans share this tailnet
2. **No shared devices** — every tailnet peer is fully under the operators control (no work laptops with separate IT, no Family Sharing devices, no temporary peers via Tailscale Funnel/Share)
3. **No Tailscale Funnel** — `:3443` is NOT exposed to the public Internet via Tailscale Funnel
4. **No Tailscale Share with non-trusted parties**
5. **Caddy stays loopback-only on `:3443`** for everything except Tailscale interfaces (current behavior; verify after macOS upgrades)
6. **TLS cert remains valid** — Lets Encrypt cert auto-renews via `tailscale cert`; if renewal breaks, requests fall back to no-TLS or self-signed which is a separate problem class
7. **No third-party Paperclip plugins** that proxy traffic outward in a way that would broaden exposure

If any of these change, switch to `authenticated + private` per §6 below.

## 6. Migration Path Back to the Canonical Model

If a trip-wire fires:

1. Edit `~/.paperclip/instances/default/config.json`:
   - `server.deploymentMode: "authenticated"`
   - `server.exposure: "private"`
   - Keep `server.host: "127.0.0.1"` (Caddy still proxies)
2. Restart `ai.paperclip` (`launchctl kickstart -k gui/$(id -u)/ai.paperclip`)
3. Watch `server.log` for the one-time claim URL (`/board-claim/<token>?code=<code>`)
4. Open it from a tailnet client, sign in to the desired user, claim the instance
5. Update `~/bin/paperclip-discord-watcher.py` and any other scripts to attach an API token to `Authorization: Bearer …`
6. Delete `~/.paperclip/auth.json`s `local-board` token; re-issue under the claimed user

## 7. What This Does NOT Change

- `secrets.strictMode` stays `false` — solo operator, low penalty for a missing optional secret
- `auth.disableSignUp` stays `false` — moot in `local_trusted` (no sign-up flow exposed)
- `telemetry.enabled` stays `false` (already off by operator preference)
- All upstream auto-updates continue to apply normally

## 8. Verification Checklist (re-run quarterly)

- [ ] `lsof -nP -iTCP -sTCP:LISTEN | grep 3100` shows only loopback
- [ ] Caddyfile `:3443` block still has only `reverse_proxy localhost:3100` and the Tailscale TLS cert
- [ ] `tailscale status` shows only operator-owned devices, no shares/funnels active
- [ ] `~/.paperclip/instances/default/config.json` `server.deploymentMode` still `local_trusted` (or has been migrated per §6)

## 9. Related Docs

- `doc/DEPLOYMENT-MODES.md` — canonical mode definitions
- `doc/plans/2026-02-23-deployment-auth-mode-consolidation.md` — historical context for the canonical model
- `MAC_MINI_AUDIT_2026-04-28.md` — the audit that produced this decision
