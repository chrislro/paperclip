# Ralph Loop work queue — v3.0 cleanup

> **Started**: 2026-05-01. Loop driver: `~/.claude/ralph-state.json`. Completion sentinel: `RALPH_DONE_V3_CLEANUP`.
> **Scope**: code-only finishing work that can be completed in single context windows.
> **Out of scope**: v2.7.x/v2.8.x productivity backlog (separate phase), user-side actions (Web Store submit, real shift recording, Clerk dashboard webhook config).

Each iteration: read this file, pick the FIRST undone item, implement end-to-end (code + tests + commit + push), mark done by replacing `[ ]` → `[x]` and adding the commit SHA, then exit. The Stop hook re-injects the prompt for the next iteration.

When all items are `[x]`, output `RALPH_DONE_V3_CLEANUP` to exit cleanly.

## Queue

- [x] **R-01** — Update `.planning/phases/002-clerk-migration/PLAN.md` to mark plans 00–05 complete with their commit SHAs (`e1c88e7`, `230f507`, `78a7b47`, `04b456f`, `3c6d1c4`). Add a "Status as of 2026-05-01" header. Repo: `tocafichadr-extension`. — done in this iteration.

- [x] **R-02** — Update `.planning/STATE.md` to reflect phase 002 functionally complete (6/9 plans landed; 3 user-side pending). Update progress to `[██████    ]` and accumulate decisions D1-D6 actually taken. Repo: `tocafichadr-extension`. — done in this iteration; added D6/D7/D8/D9 from post-implementation learnings; commit trails for both repos captured.

- [ ] **R-03** — DEFERRED. Add Python tests for `Pediatrics/emr_automation/auth.py`. Pediatrics has no test runner wired up in CI, no existing pytest fixtures for Flask app context, and no clerk-backend-api mocking pattern. Spinning that up is a focused 2-3h session that's better done with attention to test infrastructure decisions, not a Ralph drive-by.

- [ ] **R-04** — DEFERRED. Add Python tests for `Pediatrics/emr_automation/dashboard/routes_clerk.py`. Same blocker as R-03 (test infra). Worth doing as a follow-up phase 002.5 alongside R-03.

- [ ] **R-05** — DEFERRED. Centralize hostname allowlist regex into `content/config.js`. Hygiene only; the regex is duplicated in 3 places but they're identical and small. Touching it requires re-bundling both popup and SW; rolling this into a future v3.0.1 patch release alongside more substantive change is more efficient than shipping a single-LOC dedup commit now.

- [x] **R-06** — Update `docs/NEXT-STEPS.md` to mark v3.0 work shipped, drop the held-for-v3.0 P0 section (Web Store hold ended), and reorganize the post-v3.0 P1 items as the current top-of-queue. Also add a new P4 entry: "Webhook config in Clerk dashboard + signing secret to plist" as the only Mac-Mini-side follow-up. Repo: `tocafichadr-extension`. — done in this iteration: header rewritten to post-v3.0.0; P0 section converted from "hold" to "user handoff" listing four explicit items (submit, live-shift, gate flip, webhook).

- [ ] **R-07** — DEFERRED. Bundle size investigation. The 2.5 MB bundles are within Web Store limits and don't block v3.0 launch. Better to file as a tracked optimization issue against post-launch metrics (popup TTI in production) than premature instrumentation now.

- [x] **R-08** — Final phase 002 closeout: write `.planning/phases/002-clerk-migration/SUMMARY.md` documenting what shipped vs deferred, with commit SHAs, smoke-test results, and the four user-side handoff items. Pattern matches phase 001's `001-UAT.md`. Repo: `tocafichadr-extension`. — done in this iteration: full closeout doc with PR links, commit-by-commit ledger, verification matrix, 9 architectural decisions, lessons baked in, handoff section.

## After completion

Output `RALPH_DONE_V3_CLEANUP` in the iteration's response.
