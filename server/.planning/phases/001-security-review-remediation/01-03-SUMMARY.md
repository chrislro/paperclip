---
phase: 001-security-review-remediation
plan: 03
subsystem: audio-capture
tags: [mediarecorder, track-ended, fail-fast]
requirements-completed: [P1-4]
affects: []
key-files:
  modified: [content/audio-capture.js]
commit: f3bf0d8
completed: 2026-04-22
---

# Plan 01-03 — audio track.ended observer

**Mic stream death mid-recording now fails fast through the existing `stop()` pipeline instead of silently producing truncated audio.**

## Accomplishments

- Attached `ended` listener on `_stream.getAudioTracks()[0]` immediately after `getUserMedia` resolves.
- Listener calls the existing `stop()` helper wrapped in `try/catch` when `_recording` is true.
- MIME negotiation, 32 kbps bitrate, 1-second chunk interval, and `MIN_BLOB_BYTES < 500` guard all untouched.

## Files

- `content/audio-capture.js` — +17 / -0 (single additive block)

## Commit

`f3bf0d8` — `fix: observe audio track.ended to fail fast on mic stream death`

## Deviations

None. Used `var _endedTrack` (rather than `const`) to match the file's existing `var` style in `start()` body.

## Follow-ups

- Live-shift verification: open `chrome://settings/content/microphone` mid-recording, block the mic, confirm the HUD surfaces the "muito curta" error as expected. Not required to close P1-4 but would round out evidence.
