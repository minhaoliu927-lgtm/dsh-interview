import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRealtimeProvider, validateRealtimeConfig } from '../src/voice/realtime-provider.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pcm = bytes => Buffer.alloc(bytes).toString('base64');
const config = { region: 'beijing', workspace: 'work-123', model: 'qwen3.5-omni-plus-realtime', credentialRef: 'host/audio-key' };
const tool = { name: 'zhijing_interview_answer', description: 'Confirm an interview answer',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } };
class FakeSocket extends EventTarget {
  readyState = 0; bufferedAmount = 0; sent = []; closed = 0; sequence = 0;
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.closed++; }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(event) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event_id: `server_${++this.sequence}`, ...event }) })); }
  raw(value) { this.dispatchEvent(new MessageEvent('message', { data: value })); }
}
function setup(t, options = {}) {
  const socket = new FakeSocket(), events = [], connections = [], credentials = [];
  const provider = createRealtimeProvider({ resolveCredential: async (ref, context) => { credentials.push({ ref, context }); return 'test-only-secret'; },
    socketFactory: async (url, args) => { connections.push({ url, args }); return socket; }, onEvent: event => events.push(event), ...options });
  t.after(() => provider.close());
  const start = (extra = {}) => provider.connect({ config, sessionId: 'host-session', epoch: 1, instructions: 'Conduct this interview using the frozen profile.', ...extra });
  const created = async () => { await tick(); socket.open(); socket.message({ type: 'session.created', session: { id: 'vendor-session' } }); };
  const acknowledge = () => socket.message({ type: 'session.updated', session: { id: 'vendor-session', model: config.model, input_audio_format: 'pcm', output_audio_format: 'pcm' } });
  const ready = async () => { const pending = start(); await created(); acknowledge(); await pending; };
  return { socket, provider, events, connections, credentials, start, created, acknowledge, ready };
}
const response = (socket, responseId = 'response-1') => socket.message({ type: 'response.created', response: { id: responseId, status: 'in_progress' } });
const output = (socket, type, data = {}) => socket.message({ type, response_id: 'response-1', item_id: 'assistant-1', ...data });
const speech = (socket, itemId = 'user-1') => {
  socket.message({ type: 'input_audio_buffer.speech_started', item_id: itemId });
  socket.message({ type: 'input_audio_buffer.speech_stopped', item_id: itemId });
  socket.message({ type: 'input_audio_buffer.committed', item_id: itemId });
};

test('official workspace endpoints and credentials stay Host-only; arbitrary hosts/keys/models are rejected', async t => {
  assert.deepEqual(validateRealtimeConfig({ workspace: 'abc', credentialRef: 'ref' }), { region: 'beijing', workspace: 'abc', credentialRef: 'ref', model: config.model });
  for (const invalid of [{ ...config, apiKey: 'secret' }, { ...config, endpoint: 'https://evil.example' }, { ...config, workspace: 'x.evil.example' },
    { ...config, workspace: 'x/../../' }, { ...config, region: 'elsewhere' }, { ...config, model: 'text-only-model' }, { ...config, credentialRef: '' }]) {
    assert.throws(() => validateRealtimeConfig(invalid), { code: 'invalid-config' });
  }
  const f = setup(t); const pending = f.start({ config: { ...config, region: 'singapore' } });
  await f.created(); f.acknowledge(); await pending;
  assert.equal(f.connections[0].url, 'wss://work-123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime');
  assert.equal(f.connections[0].args.headers.Authorization, 'Bearer test-only-secret');
  assert.equal(f.credentials[0].ref, 'host/audio-key');
  assert.equal(JSON.stringify(f.events).includes('test-only-secret'), false);
  assert.equal(JSON.stringify(f.provider.getState()).includes('credential'), false);
});

test('open and session.created are insufficient: audio waits for session.updated; explicit 16k/24k PCM and VAD', async t => {
  const f = setup(t), pending = f.start();
  await tick(); f.socket.open();
  assert.equal(f.provider.getState().phase, 'connecting'); assert.equal(f.socket.sent.length, 0);
  assert.throws(() => f.provider.appendAudio({ audioBase64: pcm(3200), seq: 0 }), { code: 'not-ready' });
  f.socket.message({ type: 'session.updated', session: { id: 'unexpected' } });
  assert.equal(f.provider.getState().phase, 'connecting');
  f.socket.message({ type: 'session.created', session: { id: 'vendor-session' } });
  assert.equal(f.provider.getState().phase, 'configuring');
  const update = f.socket.sent[0]; assert.equal(update.type, 'session.update');
  assert.deepEqual(update.session.audio, { input: { format: { type: 'pcm', sample_rate: 16000 } }, output: { format: { type: 'pcm', sample_rate: 24000 } } });
  assert.equal(update.session.turn_detection.type, 'server_vad'); assert.equal(update.session.enable_search, false);
  assert.deepEqual(update.session.input_audio_transcription, { model: 'qwen3-asr-flash-realtime' });
  f.acknowledge(); assert.equal((await pending).phase, 'ready');
  assert.equal(f.events.filter(event => event.type === 'ready').length, 1);
});

test('mismatched provider session or audio format cannot become ready', async t => {
  const f = setup(t), pending = f.start();
  const rejected = assert.rejects(pending, { code: 'invalid-session' });
  await f.created(); f.socket.message({ type: 'session.updated', session: { id: 'vendor-session', audio: { output: { format: { sample_rate: 48000 } } } } });
  await rejected; assert.equal(f.provider.getState().phase, 'error'); assert.equal(f.socket.closed, 1);
});

test('HTTP upgrade rejection reports safe actionable categories without request or response details', async t => {
  for (const [statusCode, code] of [[401, 'authentication-failed'], [403, 'access-denied'], [404, 'endpoint-unavailable'],
    [429, 'rate-limited'], [503, 'provider-unavailable'], [302, 'connection-failed']]) {
    const socket = new EventEmitter(); socket.readyState = 0; socket.send = () => {};
    socket.close = () => { socket.readyState = 3; };
    const f = setup(t, { socketFactory: () => socket });
    const pending = f.start(), rejected = assert.rejects(pending, cause => cause.code === code && !cause.message.includes('private'));
    await tick();
    socket.emit('unexpected-response', { headers: { Authorization: 'Bearer private-secret' } },
      { statusCode, statusMessage: 'private response body', headers: { 'set-cookie': 'private' } });
    await rejected;
    assert.equal(f.events.find(event => event.type === 'error').code, code);
    assert.equal(JSON.stringify(f.events).includes('private'), false);
    assert.equal(socket.readyState, 3);
    for (const name of ['message', 'error', 'close', 'unexpected-response']) assert.equal(socket.listenerCount(name), 0);
  }
});

test('DNS and TLS failures expose only allowlisted categories, including browser-shaped ws errors', async t => {
  for (const [nativeCode, expected] of [['ENOTFOUND', 'dns-failed'], ['EAI_AGAIN', 'dns-failed'],
    ['CERT_HAS_EXPIRED', 'tls-failed'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls-failed'], ['ECONNRESET', 'transport-failed'],
    ['private-unknown-code', 'transport-failed']]) {
    const f = setup(t), pending = f.start(), rejected = assert.rejects(pending, { code: expected });
    await tick();
    const event = new Event('error'); event.error = Object.assign(new Error('private headers and key'), { code: nativeCode });
    f.socket.dispatchEvent(event); await rejected;
    assert.equal(f.socket.closed, 1);
    assert.equal(JSON.stringify(f.events).includes('private'), false);
  }
});

test('input rejects malformed/WAV/odd/oversized PCM and never resends old sequence numbers', async t => {
  const f = setup(t, { limits: { maxChunkBytes: 3200 } }); await f.ready();
  const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8);
  for (const audioBase64 of ['!bad', 'AA=', pcm(3), pcm(3202), wav.toString('base64')]) {
    assert.throws(() => f.provider.appendAudio({ audioBase64, seq: 0 }), { code: 'invalid-audio' });
  }
  assert.equal(f.provider.appendAudio({ audioBase64: pcm(3200), seq: 0 }), true);
  assert.equal(f.provider.appendAudio({ audioBase64: pcm(3200), seq: 0 }), false);
  assert.equal(f.provider.appendAudio({ audioBase64: pcm(3200), seq: 1 }), true);
  assert.equal(f.socket.sent.filter(e => e.type === 'input_audio_buffer.append').length, 2);
  assert.equal(f.socket.sent.filter(e => e.type === 'response.create').length, 0);
});

test('input quotas are bounded across commits and socket backpressure closes rather than queues recordings', async t => {
  const f = setup(t, { limits: { maxBufferedAudioBytes: 8, maxSessionAudioBytes: 12 } }); await f.ready();
  f.provider.appendAudio({ audioBase64: pcm(8), seq: 0 }); speech(f.socket);
  f.provider.appendAudio({ audioBase64: pcm(4), seq: 1 });
  assert.throws(() => f.provider.appendAudio({ audioBase64: pcm(2), seq: 2 }), { code: 'audio-limit' });
  assert.equal(f.socket.closed, 1);
  const g = setup(t, { limits: { maxSocketBufferedBytes: 100 } }); await g.ready(); g.socket.bufferedAmount = 101;
  assert.throws(() => g.provider.appendAudio({ audioBase64: pcm(2), seq: 0 }), { code: 'backpressure' });
  assert.equal(g.socket.closed, 1);
});

test('real speech/transcript/audio events carry Host session/epoch and stable turn mappings; duplicate/stale finals are dropped', async t => {
  const f = setup(t); await f.ready(); speech(f.socket);
  f.socket.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'user-1', text: '你好', stash: '面试' });
  f.socket.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'user-1', text: '你好，', stash: '面试官。' });
  f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-1', transcript: '你好，面试官。', sessionId: 'forged', epoch: 999, turnId: 99 });
  f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-1', transcript: 'duplicate' });
  response(f.socket);
  output(f.socket, 'response.audio_transcript.delta', { delta: '请' });
  output(f.socket, 'response.audio_transcript.done', { transcript: '请介绍你自己。' });
  output(f.socket, 'response.audio_transcript.delta', { delta: 'late' });
  output(f.socket, 'response.audio.delta', { event_id: 'same-audio', delta: pcm(48) });
  output(f.socket, 'response.audio.delta', { event_id: 'same-audio', delta: pcm(48) });
  output(f.socket, 'response.audio.done');
  output(f.socket, 'response.audio.delta', { delta: pcm(48) });
  f.socket.message({ type: 'response.done', response: { id: 'response-1', status: 'completed' } });
  output(f.socket, 'response.audio.delta', { delta: pcm(48) });
  assert.equal(f.events.filter(e => e.type === 'input-transcript').length, 1);
  const transcript = f.events.find(e => e.type === 'input-transcript');
  assert.equal(transcript.sessionId, 'host-session'); assert.equal(transcript.epoch, 1); assert.equal(transcript.turnId, 1);
  assert.equal(transcript.source, 'provider-transcript');
  const preview = f.events.filter(e => e.type === 'input-transcript-delta').at(-1);
  assert.equal(preview.preview, '你好，面试官。'); assert.equal(preview.replace, true);
  assert.equal(f.events.filter(e => e.type === 'output-transcript-delta').length, 1);
  const audio = f.events.filter(e => e.type === 'audio'); assert.equal(audio.length, 1);
  assert.deepEqual([audio[0].format, audio[0].sampleRate, audio[0].channels, audio[0].responseId], ['pcm16', 24000, 1, 'response-1']);
  assert.equal(f.events.find(e => e.type === 'response-done').status, 'completed');
});

test('VAD barge-in immediately interrupts old output, keeps new input, and binds delayed user transcript to its original turn', async t => {
  const f = setup(t); await f.ready(); speech(f.socket, 'user-1'); response(f.socket);
  output(f.socket, 'response.audio.delta', { delta: pcm(48) });
  speech(f.socket, 'user-2');
  output(f.socket, 'response.audio.delta', { delta: pcm(48) });
  f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-1', transcript: '第一轮原文' });
  response(f.socket, 'response-2');
  output(f.socket, 'response.audio.delta', { response_id: 'response-2', delta: pcm(48) });
  assert.deepEqual(f.events.filter(e => e.type === 'audio').map(e => e.responseId), ['response-1', 'response-2']);
  assert.equal(f.events.find(e => e.type === 'input-transcript').turnId, 1);
  assert.equal(f.events.filter(e => e.type === 'response-started').at(-1).turnId, 2);
  assert.equal(f.socket.sent.filter(e => e.type === 'response.cancel').length, 0, 'server VAD cancellation must not race a second cancellation');
  assert.equal(f.provider.appendAudio({ audioBase64: pcm(100), seq: 0 }), true);
});

test('explicit cancellation is idempotent in effect; canceled and unbound response packets cannot replay', async t => {
  const f = setup(t); await f.ready(); response(f.socket); f.provider.cancelResponse();
  output(f.socket, 'response.audio.delta', { delta: pcm(48) });
  response(f.socket, 'late-created');
  output(f.socket, 'response.audio.delta', { response_id: 'late-created', delta: pcm(48) });
  output(f.socket, 'response.audio.delta', { response_id: 'unknown', delta: pcm(48) });
  assert.equal(f.events.some(e => e.type === 'audio'), false);
  assert.equal(f.socket.sent.filter(e => e.type === 'response.cancel').length, 1);
  assert.equal(f.events.filter(e => e.type === 'interrupted').length, 1);
  f.provider.cancelResponse();
  assert.equal(f.socket.sent.filter(e => e.type === 'response.cancel').length, 1);
});

test('initial greeting is requested explicitly once; VAD never needs per-chunk response.create', async t => {
  const f = setup(t); await f.ready();
  assert.equal(f.provider.requestResponse(), true); assert.equal(f.provider.requestResponse(), false);
  response(f.socket); assert.equal(f.provider.requestResponse(), false);
  assert.equal(f.socket.sent.filter(e => e.type === 'response.create').length, 1);
});

test('only whitelisted complete function arguments execute, duplicate call IDs never execute twice, continuation waits for response.done', async t => {
  const calls = []; const f = setup(t, { tools: [tool], onToolCall: async args => { calls.push(args); return { ok: true, saved: true }; } });
  await f.ready(); response(f.socket);
  assert.deepEqual(f.socket.sent[0].session.tools, [{ type: 'function', function: tool }]);
  output(f.socket, 'response.function_call_arguments.delta', { call_id: 'call-1', delta: 'malformed fragments are ignored' });
  output(f.socket, 'response.function_call_arguments.done', { call_id: 'call-1', name: tool.name, arguments: '{"text":"我的回答","sessionId":"forged"}' });
  output(f.socket, 'response.function_call_arguments.done', { call_id: 'call-1', name: tool.name, arguments: '{}' });
  await tick(); assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'host-session'); assert.equal(calls[0].arguments.sessionId, 'forged', 'Host validates business arguments separately');
  const returned = f.socket.sent.find(e => e.type === 'conversation.item.create');
  assert.deepEqual(returned.item, { type: 'function_call_output', call_id: 'call-1', output: '{"ok":true,"saved":true}' });
  assert.equal(f.socket.sent.filter(e => e.type === 'response.create').length, 0);
  f.socket.message({ type: 'response.done', response: { id: 'response-1', status: 'completed' } });
  assert.equal(f.socket.sent.filter(e => e.type === 'response.create').length, 1);
});

test('unlisted tools and malformed complete arguments close safely without invoking business callbacks', async t => {
  for (const [name, args, code] of [['terminal', '{}', 'tool-forbidden'], [tool.name, '[1]', 'invalid-tool-arguments'], [tool.name, '{', 'invalid-tool-arguments']]) {
    const f = setup(t, { tools: [tool], onToolCall: () => assert.fail('untrusted tool executed') }); await f.ready(); response(f.socket);
    output(f.socket, 'response.function_call_arguments.done', { call_id: 'call-1', name, arguments: args });
    await tick(); assert.equal(f.events.find(e => e.type === 'error').code, code); assert.equal(f.socket.closed, 1);
  }
  assert.throws(() => createRealtimeProvider({ resolveCredential() {}, socketFactory() {}, tools: [{ ...tool, name: 'shell' }] }), { code: 'invalid-tools' });
});

test('barge-in aborts pending Host tools and suppresses late write results and model continuation', async t => {
  let finishTool, received;
  const f = setup(t, { tools: [tool], onToolCall: args => { received = args; return new Promise(resolve => { finishTool = resolve; }); } });
  await f.ready(); response(f.socket);
  output(f.socket, 'response.function_call_arguments.done', { call_id: 'call-1', name: tool.name, arguments: '{}' });
  await tick(); speech(f.socket); assert.equal(received.signal.aborted, true);
  finishTool({ ok: true }); await tick();
  assert.equal(f.socket.sent.some(e => e.type === 'conversation.item.create'), false);
  assert.equal(f.socket.sent.some(e => e.type === 'response.create'), false);
});

test('tool timeout produces a bounded generic failure, aborts callback, and ignores its later resolution', async t => {
  let finishTool, received;
  const f = setup(t, { toolTimeoutMs: 15, tools: [tool], onToolCall: args => { received = args; return new Promise(resolve => { finishTool = resolve; }); } });
  await f.ready(); response(f.socket);
  output(f.socket, 'response.function_call_arguments.done', { call_id: 'call-1', name: tool.name, arguments: '{}' });
  f.socket.message({ type: 'response.done', response: { id: 'response-1', status: 'completed' } });
  await delay(30); assert.equal(received.signal.aborted, true);
  const result = f.socket.sent.find(e => e.type === 'conversation.item.create');
  assert.equal(result.item.output, '{"ok":false,"error":{"code":"tool-timeout"}}');
  finishTool('late secret'); await tick();
  assert.equal(f.socket.sent.filter(e => e.type === 'conversation.item.create').length, 1);
  assert.equal(JSON.stringify(f.events).includes('late secret'), false);
});

test('connection timeout bounds unresolved credentials; close bounds unresolved factory and closes its late socket', async t => {
  const f = setup(t, { connectTimeoutMs: 15, resolveCredential: () => new Promise(() => {}) });
  await assert.rejects(f.start(), { code: 'connect-timeout' }); assert.equal(f.connections.length, 0);
  let resolveSocket;
  const lateSocket = new FakeSocket();
  const g = setup(t, { socketFactory: () => new Promise(resolve => { resolveSocket = resolve; }) });
  const pending = g.start(), rejected = assert.rejects(pending, { code: 'cancelled' });
  await tick(); g.provider.close(); await rejected; resolveSocket(lateSocket); await tick();
  assert.equal(lateSocket.closed, 1); assert.equal(g.provider.getState().phase, 'closed');
});

test('AbortSignal, malformed protocol and provider errors release resources without leaking raw errors or secrets', async t => {
  const controller = new AbortController(); const f = setup(t), pending = f.start({ signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'cancelled' }); await f.created(); controller.abort('private path'); await rejected;
  assert.equal(f.socket.closed, 1);
  const g = setup(t); await g.ready();
  g.socket.message({ type: 'error', error: { code: 'bad-key', message: 'Bearer test-only-secret private-file' } });
  assert.equal(g.provider.getState().phase, 'error'); assert.equal(JSON.stringify(g.events).includes('test-only-secret'), false);
  assert.equal(JSON.stringify(g.events).includes('private-file'), false);
  const h = setup(t); await h.ready(); h.socket.raw('{');
  assert.equal(h.events.find(e => e.type === 'error').code, 'invalid-event');
});

test('response timeouts and output quota failures close without replay or disk output', async t => {
  const f = setup(t, { responseTimeoutMs: 15 }); await f.ready(); response(f.socket); await delay(25);
  assert.equal(f.events.find(e => e.type === 'error').code, 'response-timeout');
  const g = setup(t, { limits: { maxOutputResponseBytes: 4 } }); await g.ready(); response(g.socket);
  output(g.socket, 'response.audio.delta', { delta: pcm(6) });
  assert.equal(g.events.some(e => e.type === 'audio'), false); assert.equal(g.socket.closed, 1);
  const h = setup(t, { responseTimeoutMs: 15 }); await h.ready(); h.provider.requestResponse(); await delay(25);
  assert.equal(h.events.find(e => e.type === 'error').code, 'response-timeout');
});

test('close is idempotent, old transport events cannot cross an explicitly higher reconnect epoch', async t => {
  const sockets = [new FakeSocket(), new FakeSocket()], events = [];
  let index = 0;
  const f = setup(t, { socketFactory: () => sockets[index++], onEvent: event => events.push(event) });
  const first = f.start(); await tick(); sockets[0].open(); sockets[0].message({ type: 'session.created', session: { id: 'vendor-session' } });
  sockets[0].message({ type: 'session.updated', session: { id: 'vendor-session' } }); await first;
  f.provider.close(); f.provider.close(); assert.equal(sockets[0].closed, 1);
  await assert.rejects(f.start(), { code: 'invalid-session' });
  const second = f.start({ epoch: 2 }); await tick(); sockets[1].open(); sockets[1].message({ type: 'session.created', session: { id: 'second' } });
  sockets[1].message({ type: 'session.updated', session: { id: 'second' } }); await second;
  const count = events.length;
  sockets[0].message({ type: 'input_audio_buffer.speech_started', item_id: 'late-user' });
  sockets[0].dispatchEvent(new Event('close')); assert.equal(events.length, count);
  assert.equal(f.provider.getState().epoch, 2); assert.equal(f.provider.getState().phase, 'ready');
});

test('EventEmitter transports work and their handlers are removed at shutdown', async t => {
  const socket = new EventEmitter(); socket.readyState = 1; socket.sent = [];
  socket.send = raw => socket.sent.push(JSON.parse(raw)); socket.close = () => { socket.readyState = 3; };
  const f = setup(t, { socketFactory: () => socket }); const pending = f.start(); await tick();
  socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'created', type: 'session.created', session: { id: 'vendor' } })));
  socket.emit('message', Buffer.from(JSON.stringify({ event_id: 'updated', type: 'session.updated', session: { id: 'vendor' } })));
  await pending; assert.equal(socket.sent[0].type, 'session.update'); f.provider.close();
  for (const name of ['message', 'error', 'close']) assert.equal(socket.listenerCount(name), 0);
});

test('closing an EventEmitter socket during handshake drains its asynchronous abort error then removes handlers', async t => {
  const socket = new EventEmitter(); socket.readyState = 0; socket.send = () => {};
  socket.close = () => {
    socket.readyState = 2;
    queueMicrotask(() => { socket.emit('error', new Error('private handshake error')); socket.readyState = 3; socket.emit('close'); });
  };
  const f = setup(t, { socketFactory: () => socket });
  const pending = f.start(), rejected = assert.rejects(pending, { code: 'cancelled' });
  await tick(); f.provider.close(); await rejected; await tick();
  for (const name of ['message', 'error', 'close']) assert.equal(socket.listenerCount(name), 0);
  assert.equal(JSON.stringify(f.events).includes('private handshake'), false);
});

test('finishInput with no audio never commits an empty buffer and seals future audio/response requests', async t => {
  const f = setup(t); await f.ready();
  const pending = f.provider.finishInput(); assert.equal(f.provider.finishInput(), pending);
  assert.deepEqual(await pending, { complete: true, reason: null, pendingCount: 0 });
  assert.equal(f.socket.sent.some(event => event.type === 'input_audio_buffer.commit'), false);
  assert.equal(f.socket.sent.filter(event => event.type === 'session.update').length, 1);
  assert.throws(() => f.provider.appendAudio({ audioBase64: pcm(3200), seq: 0 }), { code: 'input-finished' });
  assert.equal(f.provider.requestResponse(), false);
});

test('finishInput waits for an already committed last transcript and suppresses new assistant audio', async t => {
  const f = setup(t); await f.ready(); f.provider.appendAudio({ audioBase64: pcm(3200), seq: 0 }); speech(f.socket);
  let settled = false; const pending = f.provider.finishInput().then(result => { settled = true; return result; });
  await tick(); assert.equal(settled, false); assert.equal(f.socket.closed, 0);
  response(f.socket); output(f.socket, 'response.audio.delta', { delta: pcm(48) });
  assert.equal(f.events.some(event => event.type === 'audio'), false);
  assert.equal(f.socket.sent.filter(event => event.type === 'response.cancel').length, 1);
  assert.equal(f.socket.sent.some(event => event.type === 'input_audio_buffer.commit'), false);
  f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-1', transcript: '最后一句真实回答' });
  assert.equal((await pending).complete, true);
  assert.equal(f.events.find(event => event.type === 'input-transcript').text, '最后一句真实回答');
});

test('remaining PCM is committed once only after disabling VAD, and complete final text ends graceful waiting', async t => {
  const f = setup(t); await f.ready(); f.provider.appendAudio({ audioBase64: pcm(3200), seq: 0 });
  f.socket.message({ type: 'input_audio_buffer.speech_started', item_id: 'last-user' });
  const pending = f.provider.finishInput(); f.provider.finishInput();
  assert.equal(f.socket.sent.at(-1).type, 'session.update'); assert.equal(f.socket.sent.at(-1).session.turn_detection, null);
  assert.equal(f.socket.sent.some(event => event.type === 'input_audio_buffer.commit'), false);
  f.socket.message({ type: 'session.updated', session: { id: 'vendor-session', turn_detection: null } });
  assert.equal(f.socket.sent.filter(event => event.type === 'input_audio_buffer.commit').length, 1);
  f.socket.message({ type: 'input_audio_buffer.committed', item_id: 'last-user' });
  f.socket.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'last-user', text: '最后', stash: '未完成草稿' });
  let settled = false; pending.then(() => { settled = true; }); await tick(); assert.equal(settled, false);
  f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'last-user', transcript: '最后完整原文' });
  assert.equal((await pending).complete, true);
});

test('VAD auto-commit racing with finishInput is observed before manual commit; trailing PCM uses server audio end offset', async t => {
  const f = setup(t); await f.ready(); f.provider.appendAudio({ audioBase64: pcm(3200), seq: 0 });
  const pending = f.provider.finishInput();
  speech(f.socket); // Auto-commit was already in flight before the VAD-off acknowledgement.
  f.socket.message({ type: 'session.updated', session: { id: 'vendor-session', turn_detection: null } });
  assert.equal(f.socket.sent.some(event => event.type === 'input_audio_buffer.commit'), false);
  f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-1', transcript: '已自动提交' });
  assert.equal((await pending).complete, true);
  const g = setup(t); await g.ready();
  g.provider.appendAudio({ audioBase64: pcm(3200), seq: 0 });
  g.socket.message({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  g.provider.appendAudio({ audioBase64: pcm(3200), seq: 1 });
  g.socket.message({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: 100 });
  g.socket.message({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  g.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '第一段' });
  const tail = g.provider.finishInput();
  assert.equal(g.socket.sent.at(-1).type, 'session.update', 'later 100ms must not be erased by the earlier commit');
  g.socket.message({ type: 'session.updated', session: { id: 'vendor-session', turn_detection: null } });
  assert.equal(g.socket.sent.filter(event => event.type === 'input_audio_buffer.commit').length, 1);
  g.socket.message({ type: 'input_audio_buffer.committed', item_id: 'u2' });
  g.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u2', transcript: '真正最后一段' });
  assert.equal((await tail).complete, true);
});

test('graceful input timeout and transcription failure report incomplete rather than manufacturing an answer', async t => {
  const f = setup(t, { inputFinalizationTimeoutMs: 20 }); await f.ready();
  f.provider.appendAudio({ audioBase64: pcm(3200), seq: 0 }); speech(f.socket);
  const result = await f.provider.finishInput(); assert.equal(result.complete, false); assert.equal(result.reason, 'transcript-incomplete');
  assert.equal(f.events.some(event => event.type === 'input-transcript'), false);
  const g = setup(t); await g.ready(); speech(g.socket); const pending = g.provider.finishInput();
  g.socket.message({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'user-1', error: { message: 'private provider details' } });
  assert.equal((await pending).reason, 'transcript-incomplete');
  assert.equal(JSON.stringify(g.events).includes('private provider'), false);
});

test('abort/close promptly releases a pending finishInput, drops late final packets and clears its timer', async t => {
  const f = setup(t); await f.ready(); f.provider.appendAudio({ audioBase64: pcm(3200), seq: 0 }); speech(f.socket);
  const pending = f.provider.finishInput(); f.provider.close();
  assert.equal((await pending).complete, false); assert.equal(f.socket.closed, 1);
  const count = f.events.length;
  f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-1', transcript: 'late after close' });
  assert.equal(f.events.length, count);
});
