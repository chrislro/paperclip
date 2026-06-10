// scripts/test-vad.js — Unit tests for the VAD pure math.
// Run with: node --test scripts/test-vad.js
// Uses Node's built-in test runner — no dependencies, no bundler.

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');

const vad = require(path.join(__dirname, '..', 'content', 'vad-helpers.js'));
const { rmsDb, clampThreshold, vadStep, createState, constants } = vad;

// ---------- rmsDb ----------

test('rmsDb: pure silence (all zeros) returns the dB floor', () => {
  const buf = new Float32Array(1024); // all zeros
  const db  = rmsDb(buf);
  assert.equal(db, constants.DB_FLOOR);
  assert.ok(Number.isFinite(db), 'must not be -Infinity');
});

test('rmsDb: full-scale signal (alternating ±1.0) is ~0 dBFS', () => {
  const buf = new Float32Array(1024);
  for (let i = 0; i < buf.length; i++) buf[i] = (i % 2 === 0) ? 1.0 : -1.0;
  // RMS = sqrt(mean(v^2)) = sqrt(1) = 1.0 → 20*log10(1) = 0 dB
  const db = rmsDb(buf);
  assert.ok(Math.abs(db - 0) < 1e-6, `expected ~0 dB, got ${db}`);
});

test('rmsDb: empty buffer returns DB_FLOOR (no NaN, no throw)', () => {
  assert.equal(rmsDb(new Float32Array(0)), constants.DB_FLOOR);
  assert.equal(rmsDb(null), constants.DB_FLOOR);
});

// ---------- clampThreshold ----------

const CURRENT_PRESET = constants.PRESETS.current;

test('clampThreshold: low ambient (-80) is clamped to VAD_MIN_THRESHOLD_DB (-50)', () => {
  // floor + 9 = -71, which is below the clamp; should return -50.
  assert.equal(clampThreshold(-80, CURRENT_PRESET.minThresholdDb, CURRENT_PRESET.offsetDb), CURRENT_PRESET.minThresholdDb);
});

test('clampThreshold: high ambient (-30) returns floor + offset (-21)', () => {
  // -30 + 9 = -21, which is above -50, so the offset rule wins.
  assert.equal(clampThreshold(-30, CURRENT_PRESET.minThresholdDb, CURRENT_PRESET.offsetDb), -30 + CURRENT_PRESET.offsetDb);
});

test('clampThreshold: non-finite ambient returns the clamp', () => {
  assert.equal(clampThreshold(Infinity, CURRENT_PRESET.minThresholdDb, CURRENT_PRESET.offsetDb), CURRENT_PRESET.minThresholdDb);
  assert.equal(clampThreshold(NaN, CURRENT_PRESET.minThresholdDb, CURRENT_PRESET.offsetDb), CURRENT_PRESET.minThresholdDb);
});

// ---------- vadStep state machine ----------

function freshState(t0) {
  return createState('current', t0);
}

test('vadStep: full lifecycle calibration → voice → silence-with-hangover → silence-past-hangover', () => {
  const t0 = 1_000_000;
  let state = freshState(t0);

  // --- Calibration window (0–249 ms): every tick decision is 'calibrate', no transitions.
  let r = vadStep(state, -65, t0 + 50);
  assert.equal(r.decision, 'calibrate');
  assert.equal(r.state.calibrationFloor, null);
  assert.equal(r.state.calibrationMin, -65);
  state = r.state;

  r = vadStep(state, -70, t0 + 150); // new running min
  assert.equal(r.decision, 'calibrate');
  assert.equal(r.state.calibrationMin, -70);
  state = r.state;

  // Tick at t0+260 finalizes calibration: floor = -70, lastVoiceTs reset to nowMs.
  r = vadStep(state, -68, t0 + 260);
  assert.equal(r.decision, 'calibrate');
  assert.equal(r.state.calibrationFloor, -70);
  assert.equal(r.state.lastVoiceTs, t0 + 260);
  assert.equal(r.state.voiceActive, true);
  state = r.state;

  // Threshold for floor=-70 should be max(-70+9, -50) = -50.
  assert.equal(clampThreshold(state.calibrationFloor, CURRENT_PRESET.minThresholdDb, CURRENT_PRESET.offsetDb), CURRENT_PRESET.minThresholdDb);

  // --- Drop below threshold but within hangover (300 ms) → no pause yet.
  r = vadStep(state, -60, t0 + 400); // 140 ms after lastVoiceTs (260)
  assert.equal(r.decision, 'noop');
  assert.equal(r.state.voiceActive, true);
  state = r.state;

  // --- Voice frame (above -50) → 'noop' (already active) but lastVoiceTs updates.
  r = vadStep(state, -20, t0 + 500);
  assert.equal(r.decision, 'noop');
  assert.equal(r.state.lastVoiceTs, t0 + 500);
  assert.equal(r.state.voiceActive, true);
  state = r.state;

  // --- Silence within hangover (≤300 ms after t0+500) → still 'noop'.
  r = vadStep(state, -90, t0 + 700); // 200 ms after lastVoiceTs
  assert.equal(r.decision, 'noop');
  assert.equal(r.state.voiceActive, true);
  state = r.state;

  // --- Silence past hangover (>=300 ms after lastVoiceTs) → 'pause'.
  r = vadStep(state, -90, t0 + 800); // 300 ms after lastVoiceTs (500)
  assert.equal(r.decision, 'pause');
  assert.equal(r.state.voiceActive, false);
  state = r.state;

  // --- Voice returns after pause → 'resume'.
  r = vadStep(state, -10, t0 + 900);
  assert.equal(r.decision, 'resume');
  assert.equal(r.state.voiceActive, true);
  assert.equal(r.state.lastVoiceTs, t0 + 900);
});

test('vadStep: pure function — does not mutate input state', () => {
  const t0 = 2_000_000;
  const state = freshState(t0);
  state.calibrationFloor = -60;       // post-calibration shape
  // Shallow clone — JSON.stringify can't round-trip Infinity (calibrationMin).
  const snapshot = Object.assign({}, state);

  const r = vadStep(state, -10, t0 + 1000);

  assert.deepEqual(state, snapshot, 'vadStep must not mutate input state');
  assert.notEqual(r.state, state, 'must return a new state object');
});
