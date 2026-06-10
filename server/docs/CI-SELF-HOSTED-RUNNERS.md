# Self-hosted CI runners

This repo's CI runs on **self-hosted macOS (Apple Silicon) runners** on the MacBook,
not GitHub-hosted runners (GitHub-hosted billing is disabled by design — use local runners).

## Runners (labels: `self-hosted, macOS, ARM64`)
| Repo | Runner name |
|---|---|
| tocafichadr-extension | `macbook-tocafichadr` |
| ditare | `macbook-pro` |
| PlantonistaPro | `macbook-pro-plantonistapro` |
| conduta-rapida | `macbook-conduta` (added 2026-05-29) |

## Gotcha 1 — Python: do NOT use `actions/setup-python` on these runners
The prebuilt macOS Python from `actions/python-versions` is **non-relocatable**: it hardcodes
`/Users/runner/hostedtoolcache`, so on a runner whose home is `/Users/admin` it dies with
`mkdir: /Users/runner: Permission denied`. Seeding `RUNNER_TOOL_CACHE` does not help — the
runner wipes `_work/_tool` between jobs.

**Fix (used in `backend.yml` + `extension.yml`):** set up Python with **`uv`** instead — its
Pythons are relocatable and live in `~/.local/share/uv` (not wiped), the venv goes in
`$RUNNER_TEMP`:
```yaml
- name: Set up Python via uv
  run: |
    export PATH="$HOME/.local/bin:$PATH"
    uv python install 3.11
    uv venv --seed --python 3.11 "$RUNNER_TEMP/pyvenv"   # --seed provides pip
    echo "$RUNNER_TEMP/pyvenv/bin" >> "$GITHUB_PATH"      # downstream python/pip use the venv
```

## Gotcha 2 — esbuild + node builtins
Bundling for the browser (`--target=chrome120`) fails on `safe-buffer`'s `require('buffer')`
("Could not resolve buffer"). Fix: add the `buffer` browser polyfill as a dependency.

## Adding a new runner
Do **not** clone an existing runner directory (the service identity bleeds into the new one and
`config.sh`/`svc.sh` get confused). Fresh-download the tarball from `actions/runner` releases,
then `./config.sh --url <repo> --token <reg-token> --labels self-hosted,macOS,ARM64 --unattended`
and `./svc.sh install && ./svc.sh start`. For `setup-node`/Python tooling, set
`RUNNER_TOOL_CACHE` in the runner's `.env`.
