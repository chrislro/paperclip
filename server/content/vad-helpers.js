/**
 * vad-helpers.js — Enhanced VAD with A/B configuration support
 *
 * Supports 4 modes:
 *   - off:           No silence trimming (baseline)
 *   - current:       Existing real-time VAD (300ms hangover, 9dB offset)
 *   - less-aggressive: Longer hangover (500ms), higher offset (12dB), higher floor (-45dB)
 *   - post-trim:     No real-time VAD; marks segments for post-processing trim
 *
 * Pure functions: no browser dependencies, testable under Node.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.TOCAFICHADR_vad = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ---- Mode presets ----
    var PRESETS = {
        off: {
            enabled: false,
            offsetDb: 9,
            minThresholdDb: -50,
            hangoverMs: 300,
            calibrationMs: 250,
        },
        current: {
            enabled: true,
            offsetDb: 9,
            minThresholdDb: -50,
            hangoverMs: 300,
            calibrationMs: 250,
        },
        'less-aggressive': {
            enabled: true,
            offsetDb: 12,
            minThresholdDb: -45,
            hangoverMs: 500,
            calibrationMs: 250,
        },
        'post-trim': {
            enabled: true,
            offsetDb: 9,
            minThresholdDb: -50,
            hangoverMs: 300,
            calibrationMs: 250,
            postTrim: true,  // Flag: don't pause recorder, just mark segments
        },
    };

    var DB_FLOOR = -140;

    /**
     * Get preset configuration by mode name.
     */
    function getPreset(mode) {
        return PRESETS[mode] || PRESETS.current;
    }

    /**
     * rmsDb(buf) — RMS of a Float32 time-domain PCM buffer.
     */
    function rmsDb(buf) {
        if (!buf || buf.length === 0) return DB_FLOOR;
        var sum = 0;
        for (var i = 0; i < buf.length; i++) {
            var v = buf[i];
            sum += v * v;
        }
        var rms = Math.sqrt(sum / buf.length);
        if (rms < 1e-7) return DB_FLOOR;
        return 20 * Math.log10(rms);
    }

    /**
     * clampThreshold(ambientDb, minThresholdDb, offsetDb)
     */
    function clampThreshold(ambientDb, minThresholdDb, offsetDb) {
        if (typeof ambientDb !== 'number' || !isFinite(ambientDb)) {
            return minThresholdDb;
        }
        return Math.max(ambientDb + offsetDb, minThresholdDb);
    }

    /**
     * createState(mode, nowMs) — Initialize VAD state for a given mode.
     */
    function createState(mode, nowMs) {
        var preset = getPreset(mode);
        return {
            mode: mode,
            preset: preset,
            voiceActive: true,
            calibrationFloor: null,
            calibrationMin: Infinity,
            startedAt: nowMs,
            lastVoiceTs: nowMs,
            // Post-trim state: record all decisions for later analysis
            segments: preset.postTrim ? [] : null,
            totalVoiceMs: 0,
            totalSilenceMs: 0,
            pauseCount: 0,
            resumeCount: 0,
        };
    }

    /**
     * vadStep(state, frameDb, nowMs) — Pure state transition for one tick.
     *
     * Returns: {state, decision, metrics}
     *   decision: 'calibrate' | 'resume' | 'pause' | 'noop'
     *   metrics:  { voiceMs, silenceMs } for this tick
     */
    function vadStep(state, frameDb, nowMs) {
        var preset = state.preset;
        var elapsed = nowMs - state.startedAt;

        // Mode: off — always noop, no recorder action
        if (!preset.enabled) {
            return {
                state: state,
                decision: 'noop',
                metrics: { voiceMs: 0, silenceMs: 0 },
            };
        }

        // 1) Calibration window
        if (state.calibrationFloor === null) {
            var newMin = state.calibrationMin;
            if (frameDb < newMin) newMin = frameDb;

            if (elapsed >= preset.calibrationMs) {
                var floor = isFinite(newMin) ? newMin : -60;
                var newState = {
                    mode: state.mode,
                    preset: preset,
                    voiceActive: true,
                    calibrationFloor: floor,
                    calibrationMin: newMin,
                    startedAt: state.startedAt,
                    lastVoiceTs: nowMs,
                    segments: state.segments,
                    totalVoiceMs: state.totalVoiceMs,
                    totalSilenceMs: state.totalSilenceMs,
                    pauseCount: state.pauseCount,
                    resumeCount: state.resumeCount,
                };
                return {
                    state: newState,
                    decision: 'calibrate',
                    metrics: { voiceMs: 0, silenceMs: 0 },
                };
            }

            return {
                state: {
                    mode: state.mode,
                    preset: preset,
                    voiceActive: state.voiceActive,
                    calibrationFloor: null,
                    calibrationMin: newMin,
                    startedAt: state.startedAt,
                    lastVoiceTs: state.lastVoiceTs,
                    segments: state.segments,
                    totalVoiceMs: state.totalVoiceMs,
                    totalSilenceMs: state.totalSilenceMs,
                    pauseCount: state.pauseCount,
                    resumeCount: state.resumeCount,
                },
                decision: 'calibrate',
                metrics: { voiceMs: 0, silenceMs: 0 },
            };
        }

        // 2) Post-calibration
        var threshold = clampThreshold(state.calibrationFloor, preset.minThresholdDb, preset.offsetDb);
        var aboveThresh = frameDb > threshold;
        var tickMs = nowMs - state.lastVoiceTs; // Approximate tick duration

        // Update segment tracking for post-trim mode
        if (preset.postTrim && state.segments) {
            state.segments.push({
                ts: nowMs,
                dB: frameDb,
                aboveThreshold: aboveThresh,
            });
        }

        if (aboveThresh) {
            var resumed = !state.voiceActive;
            var voiceMs = state.voiceActive ? tickMs : 0;
            var newState2 = {
                mode: state.mode,
                preset: preset,
                voiceActive: true,
                calibrationFloor: state.calibrationFloor,
                calibrationMin: state.calibrationMin,
                startedAt: state.startedAt,
                lastVoiceTs: nowMs,
                segments: state.segments,
                totalVoiceMs: state.totalVoiceMs + voiceMs,
                totalSilenceMs: state.totalSilenceMs,
                pauseCount: state.pauseCount,
                resumeCount: resumed ? state.resumeCount + 1 : state.resumeCount,
            };
            return {
                state: newState2,
                decision: resumed ? 'resume' : 'noop',
                metrics: { voiceMs: voiceMs, silenceMs: 0 },
            };
        }

        // Below threshold
        var silentMs = nowMs - state.lastVoiceTs;
        if (state.voiceActive && silentMs >= preset.hangoverMs) {
            var newState3 = {
                mode: state.mode,
                preset: preset,
                voiceActive: false,
                calibrationFloor: state.calibrationFloor,
                calibrationMin: state.calibrationMin,
                startedAt: state.startedAt,
                lastVoiceTs: state.lastVoiceTs,
                segments: state.segments,
                totalVoiceMs: state.totalVoiceMs,
                totalSilenceMs: state.totalSilenceMs + silentMs,
                pauseCount: state.pauseCount + 1,
                resumeCount: state.resumeCount,
            };
            return {
                state: newState3,
                decision: 'pause',
                metrics: { voiceMs: 0, silenceMs: silentMs },
            };
        }

        // Still in hangover or already paused
        var silenceMs = state.voiceActive ? 0 : tickMs;
        return {
            state: {
                mode: state.mode,
                preset: preset,
                voiceActive: state.voiceActive,
                calibrationFloor: state.calibrationFloor,
                calibrationMin: state.calibrationMin,
                startedAt: state.startedAt,
                lastVoiceTs: state.lastVoiceTs,
                segments: state.segments,
                totalVoiceMs: state.totalVoiceMs,
                totalSilenceMs: state.totalSilenceMs + silenceMs,
                pauseCount: state.pauseCount,
                resumeCount: state.resumeCount,
            },
            decision: 'noop',
            metrics: { voiceMs: 0, silenceMs: silenceMs },
        };
    }

    /**
     * computePostTrim(segments, thresholdDb) — Analyze recorded segments and
     * return voice/silence boundaries for post-recording trimming.
     *
     * segments: Array of {ts, dB, aboveThreshold}
     * Returns: Array of {startMs, endMs, type: 'voice'|'silence'}
     */
    function computePostTrim(segments, thresholdDb) {
        if (!segments || segments.length === 0) return [];

        var regions = [];
        var currentType = segments[0].aboveThreshold ? 'voice' : 'silence';
        var currentStart = segments[0].ts;

        for (var i = 1; i < segments.length; i++) {
            var type = segments[i].aboveThreshold ? 'voice' : 'silence';
            if (type !== currentType) {
                regions.push({
                    startMs: currentStart,
                    endMs: segments[i].ts,
                    type: currentType,
                });
                currentType = type;
                currentStart = segments[i].ts;
            }
        }
        // Close last region
        regions.push({
            startMs: currentStart,
            endMs: segments[segments.length - 1].ts,
            type: currentType,
        });

        return regions;
    }

    /**
     * estimateTrimmedDuration(state) — For post-trim mode, estimate how much
     * audio would remain after trimming leading/trailing silence.
     */
    function estimateTrimmedDuration(state) {
        if (!state.preset.postTrim || !state.segments) {
            return {
                originalMs: state.lastVoiceTs - state.startedAt,
                trimmedMs: state.lastVoiceTs - state.startedAt,
                savedMs: 0,
                savedPercent: 0,
            };
        }

        var regions = computePostTrim(state.segments, state.calibrationFloor || -50);
        if (regions.length === 0) {
            return { originalMs: 0, trimmedMs: 0, savedMs: 0, savedPercent: 0 };
        }

        var originalMs = regions[regions.length - 1].endMs - regions[0].startMs;

        // Trim leading silence
        var startIdx = 0;
        while (startIdx < regions.length && regions[startIdx].type === 'silence') {
            startIdx++;
        }

        // Trim trailing silence
        var endIdx = regions.length - 1;
        while (endIdx >= 0 && regions[endIdx].type === 'silence') {
            endIdx--;
        }

        if (startIdx > endIdx) {
            return { originalMs: originalMs, trimmedMs: 0, savedMs: originalMs, savedPercent: 100 };
        }

        var trimmedMs = regions[endIdx].endMs - regions[startIdx].startMs;
        var savedMs = originalMs - trimmedMs;

        return {
            originalMs: originalMs,
            trimmedMs: trimmedMs,
            savedMs: savedMs,
            savedPercent: originalMs > 0 ? (savedMs / originalMs) * 100 : 0,
        };
    }

    return {
        getPreset: getPreset,
        rmsDb: rmsDb,
        clampThreshold: clampThreshold,
        createState: createState,
        vadStep: vadStep,
        computePostTrim: computePostTrim,
        estimateTrimmedDuration: estimateTrimmedDuration,
        constants: {
            DB_FLOOR: DB_FLOOR,
            PRESETS: PRESETS,
        },
    };
}));
