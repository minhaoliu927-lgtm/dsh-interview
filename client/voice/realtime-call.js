import { createRealtimeMedia } from './realtime-media.js';

const configurationErrors = new Set(['invalid-config', 'credential-unavailable', 'not-configured', 'realtime-not-configured', 'realtime-unavailable', 'host-unavailable', 'provider-unavailable']);
const codeOf = error => typeof error?.code === 'string' ? error.code : 'connection-failed';
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const text = value => typeof value === 'string' ? value.slice(0, 32000) : '';
export const realtimeUnavailable = catalog => catalog?.available === false || catalog?.configured === false;

/** One explicitly started call. Audio never enters UI state or browser storage. */
export function createRealtimeCall({ interviewId, api, onChange = () => {}, onChanged = () => {},
  createMedia = createRealtimeMedia, createOwnerId = () => globalThis.crypto.randomUUID(), cleanupTimeoutMs = 5000, connectTimeoutMs = 30000 } = {}) {
  if (!validId(interviewId) || typeof api?.realtime?.open !== 'function' || typeof api?.realtime?.control !== 'function') throw new Error('INVALID_REALTIME_CALL');
  if (![cleanupTimeoutMs, connectTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 60000)) throw new Error('INVALID_REALTIME_TIMEOUT');
  let disposed = false, current = null, catalogScope = null;
  let state = { phase: 'idle', stopping: false, muted: false, callId: null, epoch: null, turnId: 0,
    inputTranscript: '', outputTranscript: '', inputFinal: false, outputFinal: false,
    errorCode: null, capabilityMissing: false, catalog: null, checking: false };
  const getState = () => ({ ...state });
  const publish = patch => { if (!disposed) { state = { ...state, ...patch }; onChange(getState()); } };
  const changed = () => { if (!disposed) { try { Promise.resolve(onChanged()).catch(() => {}); } catch { /* A refresh does not own the call. */ } } };
  const active = run => Boolean(run) && !disposed && current === run && !run.closed;
  const outputPhase = run => run.media?.snapshot().playing ? 'speaking' : run.waiting ? 'thinking' : 'listening';

  async function closeRemote(run, action) {
    if (!action || !run.callId || run.remoteClosing) return;
    run.remoteClosing = true;
    const scope = new AbortController(); let timer;
    try {
      await Promise.race([api.realtime.control({ callId: run.callId, ownerId: run.ownerId, action }, { signal: scope.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { scope.abort(); reject(new Error('CLEANUP_TIMEOUT')); }, cleanupTimeoutMs); })]);
    } catch { /* Stream abort also releases its server-owned call; no reconnect. */ }
    finally { clearTimeout(timer); scope.abort(); }
  }

  function stop(run, phase, errorCode = null, action = 'end', flushAudio = false) {
    if (!run || run.closed) {
      if (run?.finishingAudio && !flushAudio) {
        // Navigation/disposal wins over a user-requested tail flush. Capture is
        // already stopped; abort pending delivery and release remaining nodes.
        run.finishingAudio = false; run.flushAborted = true; run.scope.abort();
        try { void Promise.resolve(run.media?.close()).catch(() => {}); } catch { /* Already closed. */ }
      }
      return run?.stopped || Promise.resolve();
    }
    run.finishingAudio = Boolean(flushAudio && run.callId && run.ready && typeof run.media?.finishCapture === 'function');
    run.closed = true; run.ready = false; run.waiting = false;
    clearTimeout(run.connectTimer);
    if (!run.callId || !action) run.scope.abort();
    // Close local capture immediately, independently of server cleanup latency.
    let localClose, remoteClose;
    if (run.finishingAudio) {
      try { localClose = Promise.resolve(run.media.finishCapture()); } catch (error) { localClose = Promise.reject(error); }
      remoteClose = localClose.catch(error => {
        if (!run.flushAborted && current === run) publish({ phase: 'error', errorCode: error?.code || 'audio-flush-incomplete', capabilityMissing: false });
      }).then(() => { run.finishingAudio = false; return closeRemote(run, action); });
      localClose = localClose.catch(() => {});
    } else {
      try { localClose = Promise.resolve(run.media?.close()).catch(() => {}); } catch { localClose = Promise.resolve(); }
      remoteClose = closeRemote(run, action);
    }
    if (current === run) publish({ phase, stopping: true, errorCode, capabilityMissing: configurationErrors.has(errorCode), muted: false });
    run.stopped = Promise.all([localClose, remoteClose]).then(() => {
      // Let an explicit end reach Host before aborting its stream; an early
      // stream abort is a pause and would otherwise erase the user's end reason.
      run.scope.abort();
      if (current === run) publish({ stopping: false });
      changed();
    });
    return run.stopped;
  }

  function cutOutput(run, minimumTurn) {
    if (run.responseId) run.blockedResponses.add(run.responseId);
    run.responseId = null; run.waiting = false; run.outputBlocked = true;
    run.minimumOutputTurn = Math.max(run.minimumOutputTurn, minimumTurn);
    run.media?.interrupt();
  }

  function receive(run, event) {
    if (!event || typeof event !== 'object') return;
    if (active(run) && !run.callId && event.type === 'error') {
      void stop(run, 'error', typeof event.code === 'string' ? event.code : 'provider-error'); return;
    }
    if (event.type === 'call') {
      if (!validId(event.callId) || !Number.isSafeInteger(event.epoch) || event.epoch < 0) return;
      if (run.callId && (run.callId !== event.callId || run.epoch !== event.epoch)) return;
      run.callId = event.callId; run.epoch = event.epoch;
      if (!active(run)) { void closeRemote(run, 'end'); return; }
      publish({ callId: run.callId, epoch: run.epoch }); return;
    }
    if (!active(run) || !run.callId || event.epoch !== run.epoch || (event.callId !== undefined && event.callId !== run.callId)) return;
    if (event.providerEventId) {
      if (run.events.has(event.providerEventId)) return;
      if (run.events.size >= 100000) { void stop(run, 'error', 'session-limit'); return; }
      run.events.add(event.providerEventId);
    }
    if (event.type === 'error') { void stop(run, 'error', typeof event.code === 'string' ? event.code : 'provider-error'); return; }
    if (event.type === 'closed') {
      const phase = event.reason === 'ENDED' ? 'ended' : event.reason === 'PAUSED' ? 'paused' : 'error';
      void stop(run, phase, phase === 'error' ? event.reason || 'connection-closed' : null, null); return;
    }
    if (event.type === 'ready') {
      if (run.ready) return;
      if (event.inputSampleRate !== 16000 || event.outputSampleRate !== 24000 || event.format !== 'pcm16' || event.channels !== 1) {
        void stop(run, 'error', 'invalid-session'); return;
      }
      run.ready = true; clearTimeout(run.connectTimer); publish({ phase: outputPhase(run), errorCode: null }); return;
    }
    if (!run.ready) return;
    const turn = Number.isSafeInteger(event.turnId) && event.turnId >= 0 ? event.turnId : -1;
    if (['input-transcript', 'output-transcript', 'tool-result'].includes(event.type)) changed();
    if (turn < run.turn) return;
    if (event.type === 'speech-started') {
      run.turn = turn; cutOutput(run, turn);
      publish({ phase: 'listening', turnId: turn, inputTranscript: '', inputFinal: false }); return;
    }
    if (event.type === 'interrupted') {
      if (event.responseId) run.blockedResponses.add(event.responseId);
      if (event.reason === 'user') run.interruptAwaitingAck = false;
      cutOutput(run, turn);
      publish({ phase: 'listening' }); return;
    }
    if (event.type === 'speech-stopped' || event.type === 'input-committed') {
      // The provider re-enables output when it commits user audio. Manual
      // cancellation itself does not increment turnId, so that commit can be in
      // the same turn as the interruption. Events before its ack stay blocked.
      if (event.type === 'input-committed' && !run.interruptAwaitingAck) run.outputBlocked = false;
      run.turn = turn; run.waiting = true; publish({ turnId: turn, phase: outputPhase(run) }); return;
    }
    if (event.type === 'input-transcript-delta' || event.type === 'input-transcript') {
      run.turn = turn;
      publish({ turnId: turn, inputTranscript: text(event.type === 'input-transcript' ? event.text : event.preview ?? `${event.text || ''}${event.stash || ''}`), inputFinal: event.type === 'input-transcript' }); return;
    }
    if (event.type === 'input-transcript-failed') { void stop(run, 'error', 'transcription-failed'); return; }
    if (event.type === 'response-started') {
      if (run.outputBlocked || turn < run.minimumOutputTurn || !validId(event.responseId) || run.blockedResponses.has(event.responseId)) return;
      run.turn = turn; run.responseId = event.responseId; run.waiting = true;
      publish({ turnId: turn, phase: outputPhase(run), outputTranscript: '', outputFinal: false }); return;
    }
    if (run.outputBlocked || !run.responseId || event.responseId !== run.responseId || turn < run.minimumOutputTurn || run.blockedResponses.has(event.responseId)) return;
    if (event.type === 'audio') {
      try {
        if (!run.media.play({ audioBase64: event.audioBase64, sampleRate: event.sampleRate, epoch: run.media.playbackEpoch }) && active(run)) void stop(run, 'error', 'invalid-playback-audio');
      } catch { void stop(run, 'error', 'invalid-playback-audio'); }
    } else if (event.type === 'output-transcript-delta') {
      publish({ outputTranscript: text(state.outputTranscript + text(event.delta)), outputFinal: false });
    } else if (event.type === 'output-transcript') {
      publish({ outputTranscript: text(event.text), outputFinal: true });
    } else if (event.type === 'response-done') {
      run.blockedResponses.add(run.responseId); run.responseId = null; run.waiting = false;
      if (event.status !== 'completed') run.media.interrupt();
      publish({ phase: outputPhase(run) });
    }
  }

  async function start() {
    if (disposed || state.stopping || (current && !current.closed)) return false;
    if (realtimeUnavailable(state.catalog)) { publish({ phase: 'error', errorCode: state.catalog.reason || 'realtime-unavailable', capabilityMissing: true }); return false; }
    let ownerId;
    try { ownerId = createOwnerId(); if (!validId(ownerId)) throw new Error('INVALID_OWNER'); }
    catch { publish({ phase: 'error', errorCode: 'client-unavailable' }); return false; }
    const run = { ownerId, scope: new AbortController(), closed: false, ready: false,
      callId: null, epoch: null, turn: 0, minimumOutputTurn: 0, responseId: null, waiting: false, outputBlocked: false, interruptAwaitingAck: false,
      events: new Set(), blockedResponses: new Set(), remoteClosing: false, interruptPending: false };
    current = run;
    publish({ phase: 'requesting', stopping: false, muted: false, callId: null, epoch: null, errorCode: null, capabilityMissing: false });
    try {
      run.media = createMedia({
        async sendAudio({ audioBase64, seq }, { signal } = {}) {
          // Never queue microphone input while the remote handshake is pending.
          const finishing = !disposed && current === run && run.finishingAudio;
          if (!finishing && (!active(run) || !run.ready || state.muted)) return;
          try { await api.realtime.control({ callId: run.callId, ownerId: run.ownerId, action: 'audio', audioBase64, seq }, { signal: signal || run.scope.signal }); }
          catch (error) { if (active(run)) void stop(run, 'error', codeOf(error)); throw error; }
        },
        onState(mediaState) {
          if (!active(run)) return;
          if (mediaState.error) { void stop(run, 'error', mediaState.error); return; }
          if (mediaState.phase === 'closed') { void stop(run, 'paused', null, 'pause'); return; }
          publish({ muted: mediaState.muted, ...(run.ready ? { phase: outputPhase(run) } : {}) });
        },
      });
      await run.media.start();
      if (!active(run)) return false;
      if (run.media.snapshot().phase !== 'listening') { await stop(run, 'error', 'microphone-unavailable'); return false; }
      publish({ phase: 'connecting' });
      run.connectTimer = setTimeout(() => { if (active(run) && !run.ready) void stop(run, 'error', 'connect-timeout'); }, connectTimeoutMs);
      Promise.resolve().then(() => {
        if (!active(run)) return;
        return api.realtime.open({ interviewId, ownerId: run.ownerId }, { signal: run.scope.signal, onEvent: event => receive(run, event) });
      }).then(() => { if (active(run)) void stop(run, 'error', 'connection-closed'); })
        .catch(error => { if (active(run)) void stop(run, 'error', codeOf(error)); });
      return true;
    } catch (error) { await stop(run, 'error', codeOf(error)); return false; }
  }

  async function refreshCatalog() {
    if (disposed || typeof api.realtime.catalog !== 'function') return state.catalog;
    catalogScope?.abort(); const scope = new AbortController(); catalogScope = scope;
    publish({ checking: true });
    try {
      const catalog = await api.realtime.catalog({ signal: scope.signal });
      if (!disposed && catalogScope === scope && !scope.signal.aborted) publish({ catalog, checking: false, capabilityMissing: realtimeUnavailable(catalog) });
      return catalog;
    } catch (error) {
      if (!disposed && catalogScope === scope && !scope.signal.aborted) publish({ checking: false, errorCode: codeOf(error) });
      return null;
    }
  }

  return {
    getState, start, refreshCatalog,
    setMuted(value) { if (active(current) && current.ready) current.media.setMuted(Boolean(value)); },
    async interrupt() {
      const run = current;
      if (!active(run) || !run.ready || run.interruptPending || run.interruptAwaitingAck) return;
      run.interruptPending = true; run.interruptAwaitingAck = true; cutOutput(run, run.turn); publish({ phase: 'listening' });
      try { await api.realtime.control({ callId: run.callId, ownerId: run.ownerId, action: 'interrupt' }, { signal: run.scope.signal }); }
      catch (error) { if (active(run)) await stop(run, 'error', codeOf(error)); }
      finally { run.interruptPending = false; }
    },
    pause: () => stop(current, 'paused', null, 'pause', true),
    end: () => stop(current, 'ended', null, 'end', true),
    async dispose() { if (disposed) return; disposed = true; catalogScope?.abort(); await stop(current, 'ended'); },
  };
}
