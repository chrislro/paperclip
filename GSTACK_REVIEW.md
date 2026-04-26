# GSTACK_REVIEW.md

## gstack /review attempt

Command run from repo root:

```bash
claude --permission-mode bypassPermissions --print 'Load gstack. Run /review'
```

Complete output:

```text
Here are the **20 most recent open PRs**. Which one would you like me to review?

| # | Title | Author | Status |
|---|-------|--------|--------|
| **4556** | External object references across issue surfaces | PAP-2239 (internal) | DRAFT |
| **4552** | fix(ui): support generic Git repo URLs | samrusani | DRAFT |
| **4550** | feat(plugin-hooks): plugin hook registry (MYO-62 / Phase 1b) | emmanuelnurit | OPEN |
| **4549** | feat: expose env vars in OnboardingWizard agent setup | bradfeld | OPEN |
| **4547** | feat(plugins): commit Approvals Menu example source (MYO-22/MYO-41) | emmanuelnurit | OPEN |
| **4546** | ci(pr): bootstrap lockfile when new workspace package added | emmanuelnurit | OPEN |
| **4539** | Inherit priority from parent on subtask creation | De-Supermarkt | OPEN |
| **4534** | Cancel stale queued heartbeats when issue graph changes | PAP-2314 (internal) | OPEN |
| **4531** | fix(MON-335): prevent automatic reopen of blocked issues | ioseph-ai | OPEN |
| **4525** | feat(MON-307): preflight blocker recheck on wake | ioseph-ai | OPEN |
| **4520** | fix(auth): reject invalid local trusted auth fallback | iws17 | OPEN |
| **4519** | fix(issues): suppress duplicate checkout activity | supertaz | OPEN |
| **4518** | fix(recovery): add 24-hour rolling continuation run cap | supertaz | OPEN |
| **4517** | fix(recovery): add per-issue recovery enqueue rate limiter | supertaz | OPEN |
| **4516** | fix(comments): deduplicate agent-authored comments | supertaz | OPEN |
| **4515** | feat(codex): improve preflight diagnostics | alexlomt | OPEN |
| **4514** | Stop non-continuable run recovery loops | iws17 | OPEN |
| **4513** | feat: add agent instructions sync tooling | MrDeanAnderson | OPEN |
| **4512** | feat(inbox): resolve failed runs server-side | alexlomt | OPEN |
| **4511** | fix(server): validate X-Paperclip-Run-Id header against UUID regex | MrDeanAnderson | OPEN |

Give me a PR number and I'll review it.
```

Because gstack /review requested a PR number instead of reviewing the local diverged branch, I performed the requested manual fallback review of local commit `8087e3ee` (`master...origin/master` is ahead 1, behind 6).

## Manual fallback review

### Verdict

**Do not push/merge yet.** There are two high-risk issues: the commit publishes private local Mac Mini service inventory into the public Paperclip repo, and it intentionally drops the structured `paperclip` payload from OpenClaw gateway execution. The collector itself runs in one-shot mode, but the repo is diverged and typecheck could not be completed due the local `node_modules`/esbuild install being broken.

### Reviewed change set

Local commit: `8087e3ee auto-sync: 2026-04-26 19:21:39 -03`

Files changed:

- `ops/mac-mini-health-collector/README.md`
- `ops/mac-mini-health-collector/collector.py`
- `ops/mac-mini-health-collector/install.sh`
- `ops/mac-mini-health-collector/services.json`
- `package-lock.json`
- `packages/*/package.json` export/main changes
- `packages/adapters/openclaw-gateway/src/server/execute.ts`

### Critical / High findings

#### HIGH — Private/local infrastructure inventory is committed to repo

File: `ops/mac-mini-health-collector/services.json:4-77`

The committed default service list includes Chris/Jarvis-specific local service names, labels, ports, tunnel names, and notes, including OpenClaw gateway/dashboard, JarvisCall, Pedbot, Luxe staging, parser dashboard, Open WebUI, and cloudflared tunnel ports.

Risk:

- This looks like private operational inventory, not generic Paperclip source.
- If pushed upstream/publicly, it leaks local attack-surface mapping and internal project names.
- It makes the repo less reusable because the collector defaults are tied to one Mac Mini.

Recommendation:

- Replace `services.json` with a sanitized `services.example.json` containing generic placeholders only.
- Add runtime `services.json` to `.gitignore`.
- Keep Chris-specific config under private workspace/memory/config, not in Paperclip source.

#### HIGH — OpenClaw gateway no longer forwards the structured Paperclip payload

File: `packages/adapters/openclaw-gateway/src/server/execute.ts:1130-1139`

The change builds `paperclipPayload` and then discards it:

```ts
const paperclipPayload = buildStandardPaperclipPayload(ctx, wakePayload, paperclipEnv, payloadTemplate);
// ...
void paperclipPayload; // [paperclip-jarvis-patch] gateway rejects unknown 'paperclip' root field
```

Risk:

- This removes the structured `paperclip` field from the agent request entirely.
- Any downstream OpenClaw/Gateway behavior that depended on `paperclip` metadata will silently lose context.
- The comment indicates the receiving gateway rejects unknown root fields, but this fix is too broad: it solves one compatibility issue by deleting product data for every execution path.

Recommendation:

- Do not merge this as-is.
- Gate the field by adapter/gateway capability, version, or config flag instead of always dropping it.
- Add a regression test proving both paths: legacy gateway omits unsupported root fields; Paperclip-aware gateway receives the structured payload.

### Medium findings

#### MEDIUM — `package-lock.json` churn in a pnpm workspace is suspicious

File: `package-lock.json`

The repo is configured with `packageManager: pnpm@9.15.4` and already has `pnpm-lock.yaml`. This commit adds/updates a large npm lockfile with 1000+ lines.

Risk:

- Dual lockfiles can cause dependency drift and reviewer confusion.
- The local typecheck failure is already related to mismatched esbuild/native package state, so dependency hygiene matters here.

Recommendation:

- Confirm whether this project intentionally tracks `package-lock.json`.
- If not intentional, remove the npm lockfile changes and keep pnpm as the single source of truth.

#### MEDIUM — LaunchAgent installer writes a persistent service directly from a repo path

File: `ops/mac-mini-health-collector/install.sh:21-62`

The installer creates a user LaunchAgent whose `ProgramArguments` point directly at the current repo checkout path.

Risk:

- Moving/deleting the repo breaks the LaunchAgent.
- Pulling future repo changes mutates the running collector code without an explicit deploy step.
- There is no uninstall script or dry-run mode.

Recommendation:

- Copy the collector script into the Application Support runtime directory during install, or document that repo path is the runtime path.
- Add `uninstall.sh` or `install.sh --uninstall`.
- Consider `install.sh --dry-run` before writing LaunchAgents.

### Test / lint status

- `CONFIG_PATH=ops/mac-mini-health-collector/services.json OUTPUT_PATH=/tmp/paperclip-health-review.json python3 ops/mac-mini-health-collector/collector.py --once --stdout` — **PASS**. Snapshot JSON was written and parsed successfully.
- `pnpm run typecheck` — **BLOCKED/FAILS before typechecking** due local esbuild/native install mismatch:

```text
/Users/christianoliveira/Dev/paperclip/node_modules/.pnpm/@esbuild+darwin-x64@0.27.3/node_modules/@esbuild/darwin-x64/bin/esbuild: line 2: /Volumes/christianoliveira/Dev/paperclip/node_modules/.pnpm/esbuild@0.27.3/node_modules/esbuild/lib/downloaded-@esbuild-darwin-arm64-esbuild: No such file or directory
Error [TransformError]: The service was stopped
```

No package reinstall was performed.

### Suggested next steps

1. Sanitize/remove `ops/mac-mini-health-collector/services.json` before any push.
2. Rework `execute.ts` so legacy gateway compatibility does not globally discard Paperclip metadata.
3. Decide whether `package-lock.json` belongs in this pnpm workspace; remove if accidental.
4. Repair local dependencies (`pnpm install` or clean reinstall) and rerun `pnpm run typecheck` plus the relevant adapter tests.
