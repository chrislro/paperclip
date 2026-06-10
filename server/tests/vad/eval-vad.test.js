/**
 * VAD A/B evaluation test suite.
 *
 * Evaluates 4 VAD modes against synthetic audio scenarios:
 *   - off:           No VAD (baseline)
 *   - current:       Existing real-time VAD
 *   - less-aggressive: Longer hangover, higher threshold
 *   - post-trim:     Mark segments for post-processing
 *
 * Metrics per scenario/mode:
 *   - pauseCount:     Number of recorder pause events
 *   - resumeCount:    Number of recorder resume events
 *   - clippedFirstWords: Estimated (true if calibration overlaps speech start)
 *   - clippedWordEndings: Estimated (true if hangover clips trailing speech)
 *   - savedBytesPercent: Estimated bandwidth savings
 *   - f1Score:        Frame-level F1 vs ground truth
 *
 * Usage:
 *   node --test tests/vad/eval-vad.test.js
 *   node tests/vad/eval-vad.test.js --report > results.json
 */

'use strict';

const assert = require('assert');
const { describe, it } = require('node:test');
const path = require('path');

// Load vad-helpers (UMD, works under Node)
const vadHelpers = require('../../content/vad-helpers.js');

const MODES = ['off', 'current', 'less-aggressive', 'post-trim'];
const TICK_MS = 50; // 20 Hz poll rate

// ── Scenario definitions ──────────────────────────────────────

/**
 * Each scenario is an array of segments:
 *   { type: 'voice'|'silence'|'ambient', durationMs: number, dB?: number }
 *
 * Default dB levels:
 *   - voice:   -25 dB (clear speech)
 *   - silence: -90 dB (room silence)
 *   - ambient: -55 dB (quiet room, used for calibration)
 */
const SCENARIOS = [
    {
        id: 'immediate-speech',
        name: 'Doctor starts speaking immediately',
        description: 'Voice starts at t=0, overlapping calibration window. Tests if first words are clipped.',
        segments: [
            { type: 'voice', durationMs: 3000 },
        ],
    },
    {
        id: 'quiet-speech-noisy-room',
        name: 'Quiet speech in noisy room',
        description: 'Voice at -40dB with ambient at -50dB. Tests threshold adaptation.',
        segments: [
            { type: 'ambient', durationMs: 300 },
            { type: 'voice', durationMs: 2000, dB: -40 },
            { type: 'silence', durationMs: 1000, dB: -50 },
        ],
    },
    {
        id: 'trailing-silence',
        name: 'Trailing silence after speech',
        description: 'Voice followed by 2s of silence. Tests hangover and trailing clip.',
        segments: [
            { type: 'voice', durationMs: 2000 },
            { type: 'silence', durationMs: 2000 },
        ],
    },
    {
        id: 'brief-pauses',
        name: 'Brief pauses mid-sentence',
        description: '200ms pauses between words. Should NOT trigger pause under hangover.',
        segments: [
            { type: 'voice', durationMs: 500 },
            { type: 'silence', durationMs: 200 },
            { type: 'voice', durationMs: 500 },
            { type: 'silence', durationMs: 200 },
            { type: 'voice', durationMs: 500 },
        ],
    },
    {
        id: 'natural-pauses',
        name: 'Natural pauses between sentences',
        description: '600ms pauses between sentences. SHOULD trigger pause after hangover.',
        segments: [
            { type: 'voice', durationMs: 1000 },
            { type: 'silence', durationMs: 600 },
            { type: 'voice', durationMs: 1000 },
            { type: 'silence', durationMs: 600 },
            { type: 'voice', durationMs: 1000 },
        ],
    },
    {
        id: 'long-silence-mid-recording',
        name: 'Long silence mid-recording',
        description: '3 seconds of silence in the middle. Tests pause/resume stability.',
        segments: [
            { type: 'voice', durationMs: 1000 },
            { type: 'silence', durationMs: 3000 },
            { type: 'voice', durationMs: 1000 },
        ],
    },
    {
        id: 'very-quiet-room',
        name: 'Very quiet room (-80dB ambient)',
        description: 'Extremely quiet ambient. Tests floor clamping at -50dB.',
        segments: [
            { type: 'ambient', durationMs: 300, dB: -80 },
            { type: 'voice', durationMs: 2000, dB: -40 },
            { type: 'silence', durationMs: 1000, dB: -80 },
        ],
    },
    {
        id: 'loud-room',
        name: 'Loud room (-30dB ambient)',
        description: 'Noisy room with loud ambient. Tests ceiling behavior.',
        segments: [
            { type: 'ambient', durationMs: 300, dB: -30 },
            { type: 'voice', durationMs: 2000, dB: -20 },
            { type: 'silence', durationMs: 1000, dB: -30 },
        ],
    },
];

// ── Scenario runner ───────────────────────────────────────────

function runScenario(scenario, mode) {
    let gate = vadHelpers.createState(mode, 0);
    const preset = vadHelpers.getPreset(mode);
    const results = {
        mode,
        scenario: scenario.id,
        decisions: [],
        pauseCount: 0,
        resumeCount: 0,
        calibrationOverlapMs: 0,
        voiceMs: 0,
        silenceMs: 0,
        totalMs: 0,
        groundTruth: [],
    };

    let ts = 0;

    // Build frame-by-frame ground truth and run VAD
    for (const seg of scenario.segments) {
        const nFrames = Math.ceil(seg.durationMs / TICK_MS);
        const isVoice = seg.type === 'voice';
        const isAmbient = seg.type === 'ambient';
        // Default dB levels
        let dB;
        if (seg.dB !== undefined) {
            dB = seg.dB;
        } else if (isVoice) {
            dB = -25;
        } else if (isAmbient) {
            dB = -55;
        } else {
            dB = -90;
        }

        for (let i = 0; i < nFrames; i++) {
            const result = vadHelpers.vadStep(gate, dB, ts);
            gate = result.state;

            results.decisions.push({
                ts,
                decision: result.decision,
                dB,
                isVoice,
                voiceActive: gate.voiceActive,
            });

            if (result.decision === 'pause') results.pauseCount++;
            if (result.decision === 'resume') results.resumeCount++;

            results.groundTruth.push(isVoice);
            results.totalMs += TICK_MS;
            ts += TICK_MS;
        }
    }

    // Compute metrics
    const postCalDecisions = results.decisions.filter((d) => d.decision !== 'calibrate');

    // For scoring, we compare VAD's belief about voice vs ground truth.
    // - off mode: always "recording" (voiceActive never changes from initial true)
    //   This is baseline — we score it but note it's always-on.
    // - current/less-aggressive: voiceActive reflects real-time decisions
    // - post-trim: voiceActive is always true during recording, but we can
    //   score using the segment data after the fact
    let tp = 0, tn = 0, fp = 0, fn = 0;
    for (let i = 0; i < postCalDecisions.length; i++) {
        const d = postCalDecisions[i];
        // "VAD thinks voice" means the recorder would be unpaused at this moment
        // For post-trim, we score based on actual aboveThreshold flag
        const vadVoice = mode === 'post-trim' ? d.dB > -50 : d.voiceActive;
        const gtVoice = d.isVoice;

        if (vadVoice && gtVoice) tp++;
        else if (!vadVoice && !gtVoice) tn++;
        else if (vadVoice && !gtVoice) fp++;
        else if (!vadVoice && gtVoice) fn++;
    }

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    // Estimate clipped first words: calibration overlaps with voice
    // For real-time VAD modes, if voice is present during calibration,
    // the threshold may be set too high, causing immediate pause after cal.
    // For post-trim, calibration overlap doesn't clip words (everything is recorded).
    const calFrames = results.decisions.filter((d) => d.decision === 'calibrate');
    const calVoiceOverlap = calFrames.filter((d) => d.isVoice).length * TICK_MS;
    results.clippedFirstWords = calVoiceOverlap > 50 && mode !== 'off' && mode !== 'post-trim';

    // Estimate clipped word endings: count resume-after-pause within 200ms
    // This indicates the pause fired and then voice resumed very quickly,
    // suggesting the pause cut into trailing speech
    let clippedEndings = 0;
    for (let i = 1; i < results.decisions.length; i++) {
        if (results.decisions[i].decision === 'resume' && results.decisions[i - 1].decision === 'pause') {
            const gap = results.decisions[i].ts - results.decisions[i - 1].ts;
            if (gap < 200) clippedEndings++;
        }
    }
    results.clippedWordEndings = clippedEndings > 0;

    // Estimate saved bytes:
    // For real-time modes, compute from time recorder was paused.
    // For post-trim, use the trimmed duration estimate.
    let savedPercent = 0;
    if (mode === 'post-trim') {
        const trim = vadHelpers.estimateTrimmedDuration(gate);
        savedPercent = trim.savedPercent;
    } else if (mode !== 'off' && postCalDecisions.length > 0) {
        const pausedFrames = postCalDecisions.filter((d) => !d.voiceActive).length;
        savedPercent = (pausedFrames / postCalDecisions.length) * 100;
    }

    results.metrics = {
        tp,
        tn,
        fp,
        fn,
        precision: Math.round(precision * 1000) / 1000,
        recall: Math.round(recall * 1000) / 1000,
        f1: Math.round(f1 * 1000) / 1000,
        savedPercent: Math.round(savedPercent * 10) / 10,
        pauseCount: results.pauseCount,
        resumeCount: results.resumeCount,
        clippedFirstWords: results.clippedFirstWords,
        clippedWordEndings: results.clippedWordEndings,
        calVoiceOverlapMs: calVoiceOverlap,
    };

    return results;
}

// ── Tests ─────────────────────────────────────────────────────

describe('VAD A/B evaluation', () => {
    const allResults = [];

    for (const scenario of SCENARIOS) {
        describe(scenario.id, () => {
            for (const mode of MODES) {
                const result = runScenario(scenario, mode);
                allResults.push(result);

                it(`${mode}: completes without error`, () => {
                    assert.ok(result.decisions.length > 0, 'Should have decisions');
                });
            }
        });
    }

    it('generates aggregate report', () => {
        const report = generateReport(allResults);
        assert.ok(report.modes.length > 0);
        assert.ok(report.scenarios.length > 0);

        // Print report to stdout for --report flag
        if (process.argv.includes('--report')) {
            console.log(JSON.stringify(report, null, 2));
        }
    });
});

// ── Report generation ─────────────────────────────────────────

function generateReport(allResults) {
    const report = {
        generatedAt: new Date().toISOString(),
        modes: [],
        scenarios: [],
        recommendations: {},
    };

    // Per-mode aggregates
    for (const mode of MODES) {
        const modeResults = allResults.filter((r) => r.mode === mode);
        const avgF1 = modeResults.reduce((s, r) => s + r.metrics.f1, 0) / modeResults.length;
        const avgSaved = modeResults.reduce((s, r) => s + r.metrics.savedPercent, 0) / modeResults.length;
        const totalPauses = modeResults.reduce((s, r) => s + r.metrics.pauseCount, 0);
        const clippedFirst = modeResults.filter((r) => r.metrics.clippedFirstWords).length;
        const clippedEndings = modeResults.filter((r) => r.metrics.clippedWordEndings).length;

        report.modes.push({
            mode,
            avgF1: Math.round(avgF1 * 1000) / 1000,
            avgSavedPercent: Math.round(avgSaved * 10) / 10,
            totalPauses,
            clippedFirstScenarios: clippedFirst,
            clippedEndingsScenarios: clippedEndings,
            scenarioCount: modeResults.length,
        });
    }

    // Per-scenario breakdown
    for (const scenario of SCENARIOS) {
        const scenarioResults = allResults.filter((r) => r.scenario === scenario.id);
        report.scenarios.push({
            id: scenario.id,
            name: scenario.name,
            modeResults: scenarioResults.map((r) => ({
                mode: r.mode,
                f1: r.metrics.f1,
                savedPercent: r.metrics.savedPercent,
                pauseCount: r.metrics.pauseCount,
                resumeCount: r.metrics.resumeCount,
                clippedFirstWords: r.metrics.clippedFirstWords,
                clippedWordEndings: r.metrics.clippedWordEndings,
            })),
        });
    }

    // Recommendations
    const offMode = report.modes.find((m) => m.mode === 'off');
    const currentMode = report.modes.find((m) => m.mode === 'current');

    if (offMode && currentMode) {
        const savedVsOff = currentMode.avgSavedPercent;
        const f1VsOff = currentMode.avgF1;

        if (f1VsOff >= 0.9 && savedVsOff > 10) {
            report.recommendations.primary = 'current';
            report.recommendations.reason = `Good balance: ${savedVsOff.toFixed(1)}% savings with ${(f1VsOff * 100).toFixed(1)}% F1`;
        } else if (f1VsOff < 0.8) {
            report.recommendations.primary = 'off';
            report.recommendations.reason = 'Current VAD degrades accuracy too much; recommend disabling';
        } else {
            report.recommendations.primary = 'less-aggressive';
            report.recommendations.reason = 'Current VAD is too aggressive; less-aggressive mode may improve';
        }
    }

    return report;
}

// ── CLI: standalone report generation ─────────────────────────

if (require.main === module) {
    const allResults = [];
    for (const scenario of SCENARIOS) {
        for (const mode of MODES) {
            allResults.push(runScenario(scenario, mode));
        }
    }
    const report = generateReport(allResults);
    console.log(JSON.stringify(report, null, 2));
}
