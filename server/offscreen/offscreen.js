// offscreen.js — Realtime audio streaming to OpenAI Realtime API (via proxy)
// ============================================================================
// This document is created by the service worker and runs in the background
// so that audio capture + WebSocket survive popup closure (MV3 limitation).

'use strict';

const SYSTEM_PROMPT = `Você é um assistente médico especializado em pediatria e pronto-atendimento no Brasil.
O usuário é um médico que está ditando uma consulta em português do Brasil.
Sua tarefa é gerar uma nota SOAP completa, bem estruturada e profissional, pronta para copiar e colar no prontuário eletrônico.

Regras obrigatórias:
1. Use terminologia médica apropriada em português do Brasil.
2. Estruture a resposta EXATAMENTE neste formato (mantenha os títulos):

SUBJETIVO:
[Queixa principal, história da doença atual, dados relevantes]

OBJETIVO:
[Exame físico, sinais vitais, achados]

AVALIAÇÃO:
[Diagnóstico ou hipóteses diagnósticas]

PLANO:
[Conduta, prescrições, orientações ao paciente, critérios de retorno]

3. Se o médico mencionar peso e posologia em mg/kg, calcule a dose total e apresente de forma clara (ex: "Amoxicilina 500 mg, 1 comprimido de 8/8h por 7 dias").
4. NÃO adicione explicações fora do formato SOAP. Apenas o prontuário.`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let _ws = null;
let _audioCtx = null;
let _processor = null;
let _micStream = null;
let _doneTimer = null; // response.done → delayed-close timer; tracked so cleanup() can cancel it
let _proxyUrl = 'ws://127.0.0.1:5051/realtime'; // default local proxy

// ---------------------------------------------------------------------------
// Signal readiness to service worker as soon as script loads
// ---------------------------------------------------------------------------
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});

// ---------------------------------------------------------------------------
// Message handler from service worker / popup
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OFFSCREEN_START') {
    startRealtime(message.config);
    return false;
  }
  if (message.type === 'OFFSCREEN_STOP') {
    stopRealtime();
    return false;
  }
});

// ---------------------------------------------------------------------------
// Start realtime session
// ---------------------------------------------------------------------------
async function startRealtime(config) {
  // Re-entrancy guard: the offscreen document persists across popup open/close,
  // so a second OFFSCREEN_START (e.g. popup closed mid-session, reopened, and
  // started again) would orphan the previous mic stream, WebSocket, and
  // AudioContext — a leaked live mic + socket. Tear down any live session
  // first. No-op when nothing is active.
  cleanup();

  try {
    if (config.proxyUrl) {
      _proxyUrl = config.proxyUrl;
    }

    notifyPopup('REALTIME_STATUS', { status: 'recording', text: 'Solicitando microfone...' });

    // 1. Get microphone (permission must already be granted by popup)
    _micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
    });
    notifyPopup('REALTIME_STATUS', { status: 'recording', text: 'Microfone ativo. Conectando...' });

    // 2. AudioContext at OpenAI's preferred sample rate (24kHz)
    // If the device doesn't support 24kHz natively, the browser will resample internally.
    _audioCtx = new AudioContext({ sampleRate: 24000 });
    const source = _audioCtx.createMediaStreamSource(_micStream);
    _processor = _audioCtx.createScriptProcessor(4096, 1, 1);

    // Connect graph WITHOUT sending audio to speakers (offscreen doc has no visible UI).
    // We use a zero-gain node so the processor stays in the active graph.
    const muteGain = _audioCtx.createGain();
    muteGain.gain.value = 0;
    source.connect(_processor);
    _processor.connect(muteGain);
    muteGain.connect(_audioCtx.destination);

    // 3. Open WebSocket to proxy
    notifyPopup('REALTIME_STATUS', { status: 'recording', text: 'Conectando ao servidor...' });
    _ws = new WebSocket(_proxyUrl);

    _ws.onopen = () => {
      // Configure session
      sendWs({
        type: 'session.update',
        session: {
          modalities: ['text'],
          instructions: SYSTEM_PROMPT,
          input_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
        }
      });
      notifyPopup('REALTIME_STATUS', { status: 'recording', text: 'Ouvindo... fale agora' });
    };

    _ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (err) {
        console.error('[Realtime] Failed to parse WS message:', err, event.data);
      }
    };

    _ws.onerror = (err) => {
      console.error('[Realtime] WS error:', err);
      notifyPopup('REALTIME_STATUS', { status: 'error', text: 'Erro de conexão. O proxy está rodando?' });
      cleanup();
    };

    _ws.onclose = (ev) => {
      if (ev.code !== 1000) {
        console.warn('[Realtime] WS closed unexpectedly:', ev.code, ev.reason);
      }
      notifyPopup('REALTIME_STATUS', { status: 'done' });
      cleanup();
    };

    // 4. Stream audio chunks
    _processor.onaudioprocess = (e) => {
      if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
      const floatData = e.inputBuffer.getChannelData(0);
      const intData = floatTo16BitPCM(floatData);
      const base64 = arrayBufferToBase64(intData.buffer);
      sendWs({
        type: 'input_audio_buffer.append',
        audio: base64,
      });
    };

  } catch (err) {
    console.error('[Realtime] Start failed:', err);
    let friendly = err.message || 'Erro desconhecido';
    if (friendly.includes('Permission denied') || friendly.includes('NotAllowedError')) {
      friendly = 'Permissão de microfone negada. Clique no ícone do cadeado na barra de endereço e permita o microfone.';
    }
    notifyPopup('REALTIME_STATUS', { status: 'error', text: friendly });
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Stop realtime session
// ---------------------------------------------------------------------------
async function stopRealtime() {
  notifyPopup('REALTIME_STATUS', { status: 'recording', text: 'Processando...' });

  // Stop mic immediately
  if (_processor) {
    _processor.onaudioprocess = null;
    _processor.disconnect();
    _processor = null;
  }
  if (_audioCtx) {
    // Swallow a close() rejection (InvalidStateError if the browser already
    // closed the context, e.g. on an audio-hardware change). A bare `await`
    // here would throw and SKIP the mic-track stop below — leaking a live
    // microphone, which on a clinical recorder is privacy-critical. cleanup()
    // already guards close() the same way; stopRealtime must too so the mic
    // always stops.
    await _audioCtx.close().catch(() => {});
    _audioCtx = null;
  }
  if (_micStream) {
    _micStream.getTracks().forEach(t => t.stop());
    _micStream = null;
  }

  // Commit buffer and request response
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    sendWs({ type: 'input_audio_buffer.commit' });
    sendWs({ type: 'response.create' });
    // Keep WS open until response.done arrives, then close in handler
  } else {
    cleanup();
    notifyPopup('REALTIME_STATUS', { status: 'done' });
  }
}

// ---------------------------------------------------------------------------
// Handle messages from OpenAI (via proxy)
// ---------------------------------------------------------------------------
function handleServerMessage(msg) {
  const type = msg.type;

  if (type === 'response.text.delta') {
    notifyPopup('REALTIME_DELTA', { text: msg.delta || '' });
    return;
  }

  if (type === 'response.done') {
    notifyPopup('REALTIME_STATUS', { status: 'done' });
    // Close WS gracefully after a short delay to let final deltas arrive.
    // Track the timer so a re-entrant cleanup()/startRealtime() can cancel it —
    // otherwise it fires 500ms later and tears down a newly-started session.
    _doneTimer = setTimeout(() => { _doneTimer = null; cleanup(); }, 500);
    return;
  }

  if (type === 'error') {
    console.error('[Realtime] Server error:', msg);
    const errText = msg.error?.message || msg.error || 'Erro no processamento';
    notifyPopup('REALTIME_STATUS', { status: 'error', text: errText });
    return;
  }

  if (type === 'session.updated') {
    console.log('[Realtime] Session configured');
    return;
  }

  // Log other events for debugging
  console.log('[Realtime] Event:', type, msg);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendWs(payload) {
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(payload));
  }
}

function notifyPopup(type, payload) {
  try {
    chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
  } catch (_) {
    // Popup may be closed; ignore
  }
}

function cleanup() {
  if (_doneTimer) { clearTimeout(_doneTimer); _doneTimer = null; }
  if (_processor) { try { _processor.onaudioprocess = null; _processor.disconnect(); } catch(_) {} _processor = null; }
  if (_audioCtx) { _audioCtx.close().catch(()=>{}); _audioCtx = null; }
  if (_micStream) { _micStream.getTracks().forEach(t => t.stop()); _micStream = null; }
  if (_ws) {
    // Detach handlers BEFORE close(): the async onclose fires later and would
    // otherwise re-enter cleanup() — and, after a re-entrant startRealtime(),
    // tear down the freshly-started session via the now-reassigned module globals.
    const ws = _ws;
    _ws = null;
    try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; } catch(_) {}
    try { ws.close(); } catch(_) {}
  }
}

// Convert Float32 (-1..1) to Int16Array
function floatTo16BitPCM(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return output;
}

// Fast base64 from ArrayBuffer
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
