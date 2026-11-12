import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeCall } from '../client/voice/realtime-call.js';
import { createRealtimeProvider } from '../src/voice/realtime-provider.js';
import { createRealtimeMedia } from '../client/voice/realtime-media.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const opens = [], controls = [], media = [], states = [];
  let owner = 0, changes = 0;
  const api = { realtime: {
    open(input, options) { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); opens.push({ input, ...options, resolve, reject }); return promise; },
    async control(input, options) { controls.push({ ...input, signal: options?.signal }); return { ok: true }; },
  } };
  const controller = createRealtimeCall({ interviewId: 'interview-1', api, createOwnerId: () => `owner-${++owner}`, ...options,
    onChange: value => states.push(value), onChanged: () => { changes++; },
    createMedia(options) {
      let state = { phase: 'idle', muted: false, playing: false, error: null }, playbackEpoch = 0;
      const item = { options, starts: 0, closes: 0, plays: [], interruptions: 0,
        async start() { item.starts++; item.emit({ phase: 'listening' }); },
        async close() { item.closes++; item.emit({ phase: 'closed', playing: false }); },
        emit(patch) { state = { ...state, ...patch }; options.onState(state); },
        snapshot: () => state,
        setMuted(muted) { item.emit({ muted }); },
        interrupt() { item.interruptions++; playbackEpoch++; item.emit({ playing: false }); return playbackEpoch; },
        play(value) { item.plays.push(value); item.emit({ playing: true }); return true; },
        get playbackEpoch() { return playbackEpoch; },
      };
      media.push(item); return item;
    },
  });
  let event = 0;
  const emit = (data, index = opens.length - 1) => opens[index].onEvent({ callId: `call-${index + 1}`, epoch: index + 4,
    turnId: 0, providerEventId: `event-${++event}`, ...data });
  const ready = () => { emit({ type: 'call' }); emit({ type: 'ready', inputSampleRate: 16000, outputSampleRate: 24000, format: 'pcm16', channels: 1 }); };
  return { api, controller, opens, controls, media, states, emit, ready, changes: () => changes };
}

test('only an explicit start opens the microphone; input before ready is dropped and mute never queues it', async () => {
  const f = fixture(); assert.equal(f.media.length, 0); assert.equal(f.opens.length, 0);
  f.controller.setMuted(true); await f.controller.interrupt();
  await Promise.all([f.controller.start(), f.controller.start()]);
  assert.equal(f.media.length, 1); assert.equal(f.opens.length, 1);
  await f.media[0].options.sendAudio({ audioBase64: 'AAA=', seq: 0 }, {});
  assert.equal(f.controls.length, 0);
  f.ready();
  await f.media[0].options.sendAudio({ audioBase64: 'AAA=', seq: 1 }, {});
  assert.equal(f.controls[0].action, 'audio'); assert.equal(f.controls[0].seq, 1);
  f.controller.setMuted(true);
  await f.media[0].options.sendAudio({ audioBase64: 'AAA=', seq: 2 }, {});
  assert.equal(f.controls.length, 1); assert.equal(f.controller.getState().muted, true);
  await f.controller.end(); assert.equal(f.media[0].closes, 1);
});

test('interrupt clears playback immediately and gates stale call, epoch, response and turn audio', async () => {
  const f = fixture(); await f.controller.start(); f.ready();
  f.emit({ type: 'response-started', responseId: 'r0' });
  f.emit({ type: 'audio', responseId: 'r0', audioBase64: 'AAA=', sampleRate: 24000 });
  assert.equal(f.media[0].plays.length, 1);
  const interrupted = f.controller.interrupt();
  assert.equal(f.media[0].interruptions, 1);
  f.emit({ type: 'audio', responseId: 'r0', audioBase64: 'AAA=' });
  f.emit({ type: 'response-started', responseId: 'late-r0' });
  f.emit({ type: 'audio', responseId: 'late-r0', audioBase64: 'AAA=' });
  f.emit({ type: 'audio', responseId: 'r0', epoch: 3, audioBase64: 'AAA=' });
  f.emit({ type: 'audio', responseId: 'r0', callId: 'other-call', audioBase64: 'AAA=' });
  assert.equal(f.media[0].plays.length, 1); await interrupted;
  await f.controller.interrupt();
  assert.equal(f.controls.filter(row => row.action === 'interrupt').length, 1);
  f.emit({ type: 'interrupted', reason: 'user', responseId: 'r0' });
  f.emit({ type: 'speech-started', turnId: 1 });
  f.emit({ type: 'input-committed', turnId: 1 });
  f.emit({ type: 'response-started', responseId: 'r1', turnId: 1 });
  f.emit({ type: 'audio', responseId: 'r1', turnId: 1, audioBase64: 'AAA=', sampleRate: 24000 });
  assert.equal(f.media[0].plays.length, 2);
  assert.equal(f.media[0].plays[1].epoch, f.media[0].playbackEpoch);
  f.emit({ type: 'response-done', responseId: 'r1', turnId: 1, status: 'completed' });
  f.emit({ type: 'audio', responseId: 'r1', turnId: 1, audioBase64: 'AAA=' });
  assert.equal(f.media[0].plays.length, 2); await f.controller.dispose();
});

test('input previews replace rather than concatenate and duplicate output deltas are not replayed', async () => {
  const f = fixture(); await f.controller.start(); f.ready();
  f.emit({ type: 'speech-started', turnId: 1 });
  f.emit({ type: 'input-transcript-delta', turnId: 1, preview: 'Hello', replace: true });
  f.emit({ type: 'input-transcript-delta', turnId: 1, preview: 'Hello world', replace: true });
  assert.equal(f.controller.getState().inputTranscript, 'Hello world');
  f.emit({ type: 'input-transcript', turnId: 1, text: 'Hello world.' });
  assert.equal(f.controller.getState().inputFinal, true); assert.ok(f.changes() > 0);
  f.emit({ type: 'input-committed', turnId: 1 });
  f.emit({ type: 'response-started', responseId: 'r1', turnId: 1 });
  const delta = { type: 'output-transcript-delta', responseId: 'r1', turnId: 1, delta: 'Thanks', providerEventId: 'same-delta' };
  f.emit(delta); f.emit(delta); assert.equal(f.controller.getState().outputTranscript, 'Thanks');
  f.emit({ type: 'speech-started', turnId: 2 });
  f.emit({ type: 'input-transcript', turnId: 1, text: 'Late previous answer' });
  assert.equal(f.controller.getState().inputTranscript, ''); await f.controller.dispose();
});

test('a broken stream releases mic and playback, closes the remote call and never reconnects itself', async () => {
  const f = fixture(); await f.controller.start(); f.ready();
  f.opens[0].reject(Object.assign(new Error('network'), { code: 'NETWORK' })); await tick();
  assert.equal(f.media[0].closes, 1); assert.equal(f.opens[0].signal.aborted, true);
  assert.equal(f.controls.filter(row => row.action === 'end').length, 1);
  assert.equal(f.controller.getState().phase, 'error'); assert.equal(f.opens.length, 1);
  await f.controller.start(); assert.equal(f.opens.length, 2);
  f.emit({ type: 'ready' }, 0); assert.equal(f.controller.getState().phase, 'connecting');
  f.ready(); assert.equal(f.controller.getState().phase, 'listening');
  await f.controller.dispose();
});

test('page hiding or media failure closes the remote call, while pause is an explicit user restart boundary', async () => {
  const f = fixture(); await f.controller.start(); f.ready();
  f.media[0].emit({ phase: 'closed', playing: false }); await tick();
  assert.equal(f.controller.getState().phase, 'paused');
  assert.equal(f.controls.at(-1).action, 'pause');
  await f.controller.start(); f.ready();
  f.media[1].emit({ phase: 'closed', error: 'audio-transport-failed' }); await tick();
  assert.equal(f.controller.getState().phase, 'error');
  assert.equal(f.controls.at(-1).action, 'end'); assert.equal(f.opens.length, 2);
  await f.controller.dispose();
});

test('cancel during connection aborts its stream and cleans up a late call without reviving the UI', async () => {
  const f = fixture(); await f.controller.start(); await f.controller.end();
  assert.equal(f.opens[0].signal.aborted, true);
  f.emit({ type: 'call' }); await tick();
  assert.equal(f.controls.at(-1).action, 'end'); assert.equal(f.controls.at(-1).ownerId, 'owner-1');
  assert.equal(f.controller.getState().phase, 'ended');
  const count = f.states.length; await f.controller.dispose();
  f.emit({ type: 'ready' }); assert.equal(f.states.length, count);
});

test('unconfigured service is a visible settings state and releases microphone ownership', async () => {
  const f = fixture(); await f.controller.start();
  f.opens[0].reject(Object.assign(new Error('Configure in DSH'), { code: 'invalid-config' })); await tick();
  assert.equal(f.controller.getState().capabilityMissing, true);
  assert.equal(f.controller.getState().errorCode, 'invalid-config'); assert.equal(f.media[0].closes, 1);
  await f.controller.dispose();
});

test('catalog unavailable blocks microphone startup until a later user-triggered refresh', async () => {
  const f = fixture();
  f.api.realtime.catalog = async () => ({ available: false, configured: false, provider: 'qwen-realtime' });
  await f.controller.refreshCatalog(); assert.equal(await f.controller.start(), false);
  assert.equal(f.media.length, 0); assert.equal(f.controller.getState().capabilityMissing, true);
  f.api.realtime.catalog = async () => ({ available: true, configured: true, provider: 'qwen-realtime' });
  await f.controller.refreshCatalog(); await f.controller.start(); f.ready();
  assert.equal(f.opens.length, 1); await f.controller.dispose();
});

test('end releases local media immediately, gives Host its end action, then aborts the event stream', async () => {
  const f = fixture(); await f.controller.start(); f.ready();
  let resolve;
  f.api.realtime.control = async input => { f.controls.push(input); return new Promise(done => { resolve = done; }); };
  const stopped = f.controller.end();
  assert.equal(f.media[0].closes, 1); assert.equal(f.controls.at(-1).action, 'end');
  assert.equal(f.opens[0].signal.aborted, false);
  assert.equal(await f.controller.start(), false);
  resolve(); await stopped; assert.equal(f.opens[0].signal.aborted, true);
  await f.controller.dispose();
});

test('connection and remote-cleanup deadlines cannot leave the microphone or stream open', async () => {
  const f = fixture({ connectTimeoutMs: 10, cleanupTimeoutMs: 10 }); await f.controller.start();
  f.emit({ type: 'call' });
  f.api.realtime.control = async () => new Promise(() => {});
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(f.media[0].closes, 1); assert.equal(f.opens[0].signal.aborted, true);
  assert.equal(f.controller.getState().errorCode, 'connect-timeout');
  assert.equal(f.controller.getState().stopping, false); await f.controller.dispose();
});

test('a configuration error sent before call metadata still offers settings and stops capture', async () => {
  const f = fixture(); await f.controller.start();
  f.opens[0].onEvent({ type: 'error', code: 'credential-unavailable' }); await tick();
  assert.equal(f.media[0].closes, 1); assert.equal(f.controller.getState().capabilityMissing, true);
  await f.controller.dispose();
});

test('an installed audio capability without configuration still cannot open the microphone', async () => {
  const f = fixture();
  f.api.realtime.catalog = async () => ({ available: true, configured: false, provider: 'qwen-realtime' });
  await f.controller.refreshCatalog();
  assert.equal(f.controller.getState().capabilityMissing, true);
  assert.equal(await f.controller.start(), false); assert.equal(f.media.length, 0); assert.equal(f.opens.length, 0);
  await f.controller.dispose();
});

test('normal Host ENDED and PAUSED events stop local media without inventing a network error or another end request', async () => {
  for (const [reason, phase] of [['ENDED', 'ended'], ['PAUSED', 'paused'], ['session-timeout', 'error']]) {
    const f = fixture(); await f.controller.start(); f.ready();
    f.emit({ type: 'closed', reason, status: 'paused' }); await tick();
    assert.equal(f.controller.getState().phase, phase);
    assert.equal(f.controller.getState().errorCode, phase === 'error' ? reason : null);
    assert.equal(f.media[0].closes, 1); assert.equal(f.opens[0].signal.aborted, true);
    assert.equal(f.controls.length, 0); await f.controller.dispose();
  }
});

test('real provider turn semantics allow the current uncommitted answer after manual interruption and reject canceled output', async t => {
  const f = fixture(); await f.controller.start(); f.emit({ type: 'call' });
  const socket = new EventTarget(); let sequence = 0;
  socket.readyState = 1; socket.bufferedAmount = 0; socket.send = () => {}; socket.close = () => { socket.readyState = 3; };
  const message = event => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event_id: `provider-${++sequence}`, ...event }) }));
  const provider = createRealtimeProvider({ resolveCredential: async () => 'test-only-secret', socketFactory: async () => socket,
    onEvent: event => f.emit(event) });
  t.after(async () => { provider.close(); await f.controller.dispose(); });
  f.api.realtime.control = async input => {
    f.controls.push(input);
    if (input.action === 'interrupt') provider.cancelResponse();
    else if (input.action === 'audio') provider.appendAudio(input);
    else provider.close();
  };
  const connected = provider.connect({ config: { workspace: 'test-workspace', credentialRef: 'test-ref' },
    sessionId: 'native-session', epoch: 4, instructions: 'Interview the user.' });
  await tick();
  message({ type: 'session.created', session: { id: 'vendor-session' } });
  message({ type: 'session.updated', session: { id: 'vendor-session', input_audio_format: 'pcm', output_audio_format: 'pcm' } });
  await connected;
  provider.requestResponse();
  message({ type: 'response.created', response: { id: 'initial' } });
  message({ type: 'response.audio.delta', response_id: 'initial', item_id: 'assistant-0', delta: 'AAA=' });
  assert.equal(f.media[0].plays.length, 1);
  message({ type: 'input_audio_buffer.speech_started', item_id: 'user-1' });
  assert.equal(provider.getState().turnId, 1);
  await f.controller.interrupt(); assert.equal(provider.getState().turnId, 1);
  message({ type: 'response.audio.delta', response_id: 'initial', item_id: 'assistant-0', delta: 'AAA=' });
  message({ type: 'input_audio_buffer.speech_stopped', item_id: 'user-1' });
  message({ type: 'input_audio_buffer.committed', item_id: 'user-1' });
  message({ type: 'response.created', response: { id: 'answer-1' } });
  message({ type: 'response.audio.delta', response_id: 'answer-1', item_id: 'assistant-1', delta: 'AAA=' });
  assert.equal(provider.getState().turnId, 1); assert.equal(f.media[0].plays.length, 2);
  // Interrupting an already committed response does require a new user input.
  await f.controller.interrupt();
  message({ type: 'response.audio.delta', response_id: 'answer-1', item_id: 'assistant-1', delta: 'AAA=' });
  message({ type: 'response.created', response: { id: 'canceled-late' } });
  message({ type: 'response.audio.delta', response_id: 'canceled-late', item_id: 'assistant-late', delta: 'AAA=' });
  assert.equal(f.media[0].plays.length, 2);
  message({ type: 'input_audio_buffer.speech_started', item_id: 'user-2' });
  message({ type: 'input_audio_buffer.committed', item_id: 'user-2' });
  message({ type: 'response.created', response: { id: 'answer-2' } });
  message({ type: 'response.audio.delta', response_id: 'answer-2', item_id: 'assistant-2', delta: 'AAA=' });
  assert.equal(provider.getState().turnId, 2); assert.equal(f.media[0].plays.length, 3);
});

function mediaCallFixture({ holdFirst = false, flushTimeoutMs = 1000 } = {}) {
  const calls = [];
  let streamOptions, settleFirst, stopped = 0, closed = 0;
  const track = { enabled: true, stop() { stopped++; }, addEventListener() {} };
  const capture = { port: { onmessage: null, close() {} }, connect() {}, disconnect() {} };
  const context = { sampleRate: 48000, currentTime: 0, destination: {}, audioWorklet: { async addModule() {} }, async resume() {}, async close() { closed++; },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), createGain: () => ({ gain: {}, connect() {}, disconnect() {} }) };
  const api = { realtime: {
    open(_input, options) { streamOptions = options; return new Promise(() => {}); },
    async control(input, { signal } = {}) {
      calls.push({ action: input.action, seq: input.seq, bytes: input.audioBase64 ? Buffer.from(input.audioBase64, 'base64').length : 0 });
      if (input.action === 'audio' && input.seq === 0 && holdFirst) return new Promise((resolve, reject) => {
        settleFirst = resolve; signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
      return {};
    },
  } };
  const controller = createRealtimeCall({ interviewId: 'tail-interview', api, createOwnerId: () => 'tail-owner', createMedia: callbacks => createRealtimeMedia({
    ...callbacks, flushTimeoutMs, mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) },
    createAudioContext: () => context, createCaptureNode: () => capture, documentImpl: null,
    urlApi: { createObjectURL: () => 'blob:tail-test', revokeObjectURL() {} },
  }) });
  return { controller, calls, capture, release: () => settleFirst(), facts: () => ({ stopped, closed, aborted: streamOptions?.signal.aborted }),
    ready: async () => { await controller.start(); streamOptions.onEvent({ type: 'call', callId: 'tail-call', epoch: 1 });
      streamOptions.onEvent({ type: 'ready', callId: 'tail-call', epoch: 1, inputSampleRate: 16000, outputSampleRate: 24000, format: 'pcm16', channels: 1 }); } };
}

test('explicit pause and end flush the actual media queue and 50ms tail before closing the Host call', async () => {
  for (const action of ['pause', 'end']) {
    const f = mediaCallFixture({ holdFirst: true }); await f.ready();
    f.capture.port.onmessage({ data: new Float32Array(7200).fill(.2) });
    const stopping = f.controller[action]();
    assert.equal(f.facts().stopped, 1); assert.equal(f.capture.port.onmessage, null);
    assert.deepEqual(f.calls, [{ action: 'audio', seq: 0, bytes: 3200 }]);
    f.release(); await stopping;
    assert.deepEqual(f.calls, [{ action: 'audio', seq: 0, bytes: 3200 }, { action: 'audio', seq: 1, bytes: 1600 }, { action, seq: undefined, bytes: 0 }]);
    assert.equal(f.facts().closed, 1); assert.equal(f.facts().aborted, true);
    assert.equal(f.controller.getState().errorCode, null); await f.controller.dispose();
  }
});

test('navigation disposal preempts an in-flight tail flush without forwarding its remaining partial audio', async () => {
  const f = mediaCallFixture({ holdFirst: true }); await f.ready();
  f.capture.port.onmessage({ data: new Float32Array(7200) });
  const pausing = f.controller.pause(), disposed = f.controller.dispose();
  assert.equal(f.facts().stopped, 1); assert.equal(f.facts().aborted, true);
  await Promise.all([pausing, disposed]);
  assert.deepEqual(f.calls.filter(row => row.action === 'audio'), [{ action: 'audio', seq: 0, bytes: 3200 }]);
  assert.equal(f.facts().closed, 1);
});

test('a real media flush deadline remains an audio error instead of a false successful pause', async () => {
  const f = mediaCallFixture({ holdFirst: true, flushTimeoutMs: 10 }); await f.ready();
  f.capture.port.onmessage({ data: new Float32Array(7200) });
  await f.controller.pause();
  assert.equal(f.controller.getState().phase, 'error'); assert.equal(f.controller.getState().errorCode, 'audio-flush-incomplete');
  assert.equal(f.facts().stopped, 1); assert.equal(f.facts().closed, 1); assert.equal(f.facts().aborted, true);
  await f.controller.dispose();
});
