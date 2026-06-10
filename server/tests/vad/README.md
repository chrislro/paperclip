# VAD A/B Evaluation — CHRA-1110

## Overview

This directory contains the VAD (Voice Activity Detection) A/B evaluation framework for Toca Ficha Dr. It compares 4 VAD modes against synthetic audio scenarios to measure accuracy and bandwidth savings.

## VAD Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `off` | No silence trimming | Baseline; maximum accuracy, no savings |
| `current` | Existing real-time VAD (300ms hangover, 9dB offset) | Default; moderate savings |
| `less-aggressive` | Longer hangover (500ms), higher offset (12dB), higher floor (-45dB) | Reduces false pauses |
| `post-trim` | Record everything, trim silence after recording | Best accuracy + savings; no real-time gaps |

## Test Scenarios

1. **immediate-speech** — Doctor starts speaking immediately (overlaps calibration)
2. **quiet-speech-noisy-room** — Voice at -40dB with ambient at -50dB
3. **trailing-silence** — Voice followed by 2s silence (tests hangover)
4. **brief-pauses** — 200ms pauses between words (should NOT pause)
5. **natural-pauses** — 600ms pauses between sentences (SHOULD pause)
6. **long-silence-mid-recording** — 3s silence mid-recording (tests stability)
7. **very-quiet-room** — Ambient at -80dB (tests floor clamping)
8. **loud-room** — Ambient at -30dB (tests ceiling behavior)

## Running the Evaluation

### Quick test (Node.js built-in test runner)
```bash
node --test tests/vad/eval-vad.test.js
```

### Generate report
```bash
node tests/vad/eval-vad.test.js --report > tests/vad/results.json
cat tests/vad/results.json
```

### Latest Results

See `results.json` for the most recent evaluation run.

Key findings from latest run:
- **post-trim** mode: 74.6% avg savings, 0.975 F1, 0 clipped first words
- **current** mode: 66.4% avg savings, 0.494 F1, 5/8 scenarios clipped first words
- **less-aggressive** mode: 67.9% avg savings, 0.485 F1, 5/8 scenarios clipped first words

## Integration

### Selecting a VAD mode

Set the global mode before recording starts:

```javascript
// In popup.js or settings page
window.TOCAFICHADR_vadMode = 'post-trim'; // or 'off', 'current', 'less-aggressive'
```

The `content/audio-capture.js` reads this global at `_vadStart()` time.

### Adding new scenarios

Edit `tests/vad/eval-vad.test.js` and add to the `SCENARIOS` array:

```javascript
{
    id: 'my-scenario',
    name: 'Description',
    description: 'Detailed description',
    segments: [
        { type: 'voice', durationMs: 1000 },
        { type: 'silence', durationMs: 500 },
    ],
}
```

Segment types: `voice`, `silence`, `ambient`
Optional `dB` override per segment.

## Files

- `content/vad-helpers.js` — Core VAD algorithms (UMD, browser + Node)
- `content/audio-capture.js` — MediaRecorder integration
- `tests/vad/eval-vad.test.js` — Evaluation suite
- `tests/vad/results.json` — Latest evaluation results

## Notes

- Synthetic evaluation only; real audio evaluation with ASR pipeline needed for WER validation
- Frame-level scoring (50ms granularity) — sub-frame accuracy not measured
- F1 score compares VAD's voice/silence classification against ground truth
- "Saved percent" estimates bandwidth reduction from silence trimming
