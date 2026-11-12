import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRealtimeProbe } from '../src/voice/realtime-probe.js';
import { createHostServices, createRequestHandler, publicError } from '../src/host.js';

const tick = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const config = { region: 'beijing', workspace: 'probe-fixture', model: 'qwen3.5-omni-plus-realtime', credentialRef: 'AUDIO_PROBE_KEY' };
const saved = { realtimeEnabled: true, realtimeRegion: config.region, realtimeWorkspace: config.workspace,
  realtimeModel: config.model, realtimeCredential: config.credentialRef };
const pcm = (bytes, value = 1) => Buffer.alloc(bytes, value).toString('base64');
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = []; closed = 0; sequence = 0;
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.closed++; this.readyState = 3; this.emit('close'); }
  event(value) { this.emit('message', JSON.stringify({ event_id: `fixture-${++this.sequence}`, ...value })); }
}
const response = socket => socket.event({ type: 'response.created', response: { id: 'response-1' } });
const output = (socket, type, extra = {}) => socket.event({ type, response_id: 'response-1', item_id: 'output-1', ...extra });
const done = (socket, status = 'completed') => socket.event({ type: 'response.done', response: { id: 'response-1', status } });
const audio = (socket, bytes = 4800, value = 1) => output(socket, 'response.audio.delta', { delta: pcm(bytes, value) });
const transcript = socket => output(socket, 'response.audio_transcript.done', { transcript: '你好，音频测试成功。' });
async function ready(socket) {
  await tick(); socket.event({ type: 'session.created', session: { id: 'provider-session' } });
  assert.equal(socket.sent[0].type, 'session.update');
  socket.event({ type: 'session.updated', session: { id: 'provider-session', model: config.model,
    input_audio_format: 'pcm', output_audio_format: 'pcm', audio: { output: { format: { sample_rate: 24000 } } } } });
  await tick(); assert.equal(socket.sent.filter(event => event.type === 'response.create').length, 1); response(socket);
}
function fixture(t, options = {}) {
  const sockets = [], connections = [], credentials = [];
  const dependencies = { getConfig: () => config,
    resolveCredential: async (ref, context) => { credentials.push({ ref, signal: context.signal }); return 'fixture-secret'; },
    socketFactory: async (url, args) => { connections.push({ url, args }); const socket = new Socket(); sockets.push(socket); return socket; }, ...options };
  const probe = createRealtimeProbe(dependencies); t.after(() => probe.close());
  const start = (input = {}, context = {}) => probe.test(input, context);
  const running = async () => { const pending = start(); pending.catch(() => {}); await tick(); const socket = sockets.at(-1); await ready(socket); return { pending, socket }; };
  return { probe, sockets, connections, credentials, dependencies, start, running };
}
function released(socket) { assert.equal(socket.closed, 1); assert.deepEqual(socket.eventNames(), []); }

test('production protocol requires handshake, actual nonzero PCM and subtitles, returning bounded in-memory WAV only', async t => {
  const f = fixture(t), run = await f.running();
  let settled = false; run.pending.then(() => { settled = true; });
  await tick(); assert.equal(settled, false, 'handshake alone must never pass');
  transcript(run.socket); audio(run.socket); await tick(); assert.equal(settled, false, 'short samples await response completion');
  done(run.socket); const result = await run.pending;
  assert.equal(result.ok, true); assert.equal(result.provider, 'qwen-realtime'); assert.equal(result.model, config.model);
  assert.deepEqual(result.checks, { handshake: true, audio: true, transcript: true });
  assert.equal(result.audio.mimeType, 'audio/wav');
  const wav = Buffer.from(result.audio.base64, 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(4), wav.length - 8); assert.equal(wav.readUInt16LE(20), 1); assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.readUInt32LE(28), 48000); assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 4800); assert.deepEqual(wav.subarray(44), Buffer.alloc(4800, 1));
  const { ready, firstAudio, total } = result.latencyMs; assert(ready >= 0 && firstAudio >= ready && total >= firstAudio);
  assert.equal(f.credentials[0].ref, config.credentialRef); assert.equal(f.credentials[0].signal.aborted, true);
  assert.equal(f.connections[0].args.headers.Authorization, 'Bearer fixture-secret');
  assert.match(f.connections[0].url, /^wss:\/\/probe-fixture\.cn-beijing\.maas\.aliyuncs\.com\//);
  const sent = run.socket.sent;
  assert.match(sent[0].session.instructions, /你好，音频测试成功/); assert.deepEqual(sent[0].session.tools, []);
  assert.equal(sent.some(event => event.type.startsWith('input_audio_buffer.') || event.type === 'conversation.item.create'), false);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false); assert.equal(JSON.stringify(result).includes(config.workspace), false);
  released(run.socket);
});

test('oversized last chunk is trimmed to exactly three seconds and active generation is cancelled', async t => {
  const f = fixture(t), run = await f.running(); transcript(run.socket);
  audio(run.socket, 96_000, 1); audio(run.socket, 96_000, 2);
  const result = await run.pending, wav = Buffer.from(result.audio.base64, 'base64');
  assert.equal(wav.length, 144_044); assert.equal(wav.readUInt32LE(40), 144_000);
  assert.deepEqual(wav.subarray(44, 96_044), Buffer.alloc(96_000, 1)); assert.deepEqual(wav.subarray(96_044), Buffer.alloc(48_000, 2));
  assert.equal(run.socket.sent.filter(event => event.type === 'response.cancel').length, 1);
  assert(Buffer.byteLength(JSON.stringify(result)) < 200_000); released(run.socket);
});

test('three-second cap waits for subtitle without retaining later audio; a subtitle delta proves real text output', async t => {
  const f = fixture(t), run = await f.running(); audio(run.socket, 144_000);
  let settled = false; run.pending.then(() => { settled = true; }); await tick(); assert.equal(settled, false);
  audio(run.socket, 4800, 2); output(run.socket, 'response.audio_transcript.delta', { delta: '你好' });
  const result = await run.pending; assert.deepEqual(Buffer.from(result.audio.base64, 'base64').subarray(44), Buffer.alloc(144_000, 1));
  released(run.socket);
});

test('silence, missing audio, missing subtitles and failed provider responses cannot pass', async t => {
  for (const [mode, code] of [['silence', 'probe-no-audio'], ['no-audio', 'probe-no-audio'], ['no-transcript', 'probe-no-transcript'], ['failed', 'probe-response-failed']]) {
    const f = fixture(t), run = await f.running(), rejected = assert.rejects(run.pending, { code });
    if (mode !== 'no-transcript') transcript(run.socket);
    if (mode !== 'no-audio') audio(run.socket, 4800, mode === 'silence' ? 0 : 1);
    done(run.socket, mode === 'failed' ? 'failed' : 'completed'); await rejected; released(run.socket);
  }
});

test('concurrency is reserved before configuration resolves, with no second paid connection', async t => {
  const configGate = deferred(); const f = fixture(t, { getConfig: () => configGate.promise });
  const controller = new AbortController(), pending = f.start({}, { signal: controller.signal });
  await assert.rejects(f.start(), { code: 'BUSY', status: 409 }); assert.equal(f.connections.length, 0);
  const rejected = assert.rejects(pending, { code: 'cancelled' }); controller.abort(); await rejected;
  configGate.resolve(config); await tick(); assert.equal(f.connections.length, 0);
  const run = await f.running(); transcript(run.socket); audio(run.socket); done(run.socket); await run.pending; released(run.socket);
});

test('30-second hard deadline includes unresolved configuration and releases the reservation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let configured = false; const f = fixture(t, { getConfig: () => configured ? config : new Promise(() => {}) });
  const pending = f.start(), rejected = assert.rejects(pending, { code: 'probe-timeout', status: 504 });
  t.mock.timers.tick(29_999); await Promise.resolve(); assert.equal(f.connections.length, 0);
  t.mock.timers.tick(1); await rejected; configured = true;
  const controller = new AbortController(), again = f.start({}, { signal: controller.signal });
  const cancelled = assert.rejects(again, { code: 'cancelled' }); controller.abort(); await cancelled;
  assert.throws(() => createRealtimeProbe({ ...f.dependencies, timeoutMs: 30_001 }), { code: 'invalid-limits' });
});

test('hard deadline closes ready connections that never complete and cancels their active generation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(t), run = await f.running();
  transcript(run.socket); audio(run.socket); const rejected = assert.rejects(run.pending, { code: 'probe-timeout' });
  t.mock.timers.tick(30_000); await rejected; released(run.socket);
  assert.equal(run.socket.sent.filter(event => event.type === 'response.cancel').length, 1);
});

test('abort closes current connection and a late socket factory result; late events cannot revive a result', async t => {
  const controller = new AbortController(), f = fixture(t), pending = f.start({}, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'cancelled' }); await tick(); await ready(f.sockets[0]);
  controller.abort('private reason'); await rejected; released(f.sockets[0]);
  transcript(f.sockets[0]); audio(f.sockets[0]); done(f.sockets[0]);
  const late = deferred(), g = fixture(t, { socketFactory: () => late.promise });
  const latePending = g.start(), lateRejected = assert.rejects(latePending, { code: 'cancelled' }); await tick();
  g.probe.close(); await lateRejected; const lateSocket = new Socket(); late.resolve(lateSocket); await tick(); released(lateSocket);
  await assert.rejects(g.start(), { code: 'cancelled' });
});

test('cancel, close and hard timeout discard late configuration or credentials before any network request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stage of ['config', 'credentials']) {
    for (const stop of ['cancel', 'close', 'timeout']) {
      const gate = deferred(), controller = new AbortController(); let credentialCalls = 0, credentialSignal;
      const f = fixture(t, { timeoutMs: 50, getConfig: () => stage === 'config' ? gate.promise : config,
        resolveCredential: (_ref, { signal }) => { credentialCalls++; credentialSignal = signal; return gate.promise; } });
      const pending = f.start({}, { signal: controller.signal });
      const rejected = assert.rejects(pending, { code: stop === 'timeout' ? 'probe-timeout' : 'cancelled' });
      await tick(); assert.equal(f.connections.length, 0);
      if (stop === 'cancel') controller.abort(); else if (stop === 'close') f.probe.close(); else t.mock.timers.tick(50);
      await rejected; assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      if (stage === 'credentials') assert.equal(credentialSignal.aborted, true);
      gate.resolve(stage === 'config' ? config : 'fixture-secret'); await tick();
      t.mock.timers.tick(30_000); await tick();
      assert.equal(credentialCalls, stage === 'config' ? 0 : 1); assert.equal(f.connections.length, 0);
      f.probe.close(); f.probe.close();
    }
  }
});

test('late dependency rejections after cancellation are observed without leaking raw failures or reopening transport', async t => {
  for (const stage of ['config', 'credentials', 'socket']) {
    const gate = deferred(), controller = new AbortController();
    const options = stage === 'config' ? { getConfig: () => gate.promise }
      : stage === 'credentials' ? { resolveCredential: () => gate.promise } : { socketFactory: () => gate.promise };
    const f = fixture(t, options), pending = f.start({}, { signal: controller.signal });
    const rejected = assert.rejects(pending, cause => cause.code === 'cancelled' && !cause.message.includes('fixture-secret'));
    await tick(); controller.abort(); await rejected;
    gate.reject(new Error('private path and fixture-secret')); await tick();
    assert.equal(f.connections.length, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('cancellation during WebSocket handshake drains asynchronous close errors and removes every listener', async t => {
  class ConnectingSocket extends Socket {
    readyState = 0;
    close() {
      this.closed++; this.readyState = 2;
      setImmediate(() => { this.emit('error', new Error('handshake abort fixture-secret')); this.readyState = 3; this.emit('close'); });
    }
  }
  const socket = new ConnectingSocket(), controller = new AbortController();
  const f = fixture(t, { socketFactory: async () => socket });
  const pending = f.start({}, { signal: controller.signal }), rejected = assert.rejects(pending, { code: 'cancelled', status: 499 });
  await tick(); controller.abort(); f.probe.close(); await rejected; await tick();
  released(socket); assert.equal(socket.sent.length, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('request cannot supply endpoint, key, profile, prompt or microphone audio and pre-aborted work resolves no credentials', async t => {
  const f = fixture(t);
  for (const input of [null, [], { endpoint: 'wss://elsewhere.test' }, { apiKey: 'secret' }, { profile: 'personal' }, { prompt: 'read my resume' }, { audioBase64: pcm(10) }]) {
    await assert.rejects(f.start(input), { code: 'invalid-probe-input' });
  }
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.start({}, { signal: controller.signal }), { code: 'cancelled' });
  assert.equal(f.connections.length, 0); assert.equal(f.credentials.length, 0);
});

test('production provider redacts rejected credentials, transport failures and provider protocol messages', async t => {
  for (const options of [{ resolveCredential: async () => { throw new Error('Authorization: Bearer fixture-secret'); } },
    { socketFactory: async () => { throw new Error('wss://private.test?key=fixture-secret'); } }]) {
    const f = fixture(t, options);
    await assert.rejects(f.start(), cause => { assert.equal(cause.code, 'connection-failed'); assert(!JSON.stringify(publicError(cause)).includes('fixture-secret')); return true; });
  }
  const f = fixture(t), run = await f.running(), rejected = assert.rejects(run.pending, cause => {
    assert.equal(cause.code, 'provider-error'); assert(!JSON.stringify(publicError(cause)).includes('fixture-secret')); return true;
  });
  run.socket.event({ type: 'error', error: { code: 'private-code', message: 'fixture-secret', headers: { Authorization: 'fixture-secret' } } });
  await rejected; released(run.socket);
});

async function hostFixture(t, options = {}) {
  const base = resolve('.runtime/tests/realtime-probe'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'case-')), sockets = [], credentialRefs = [], touched = [];
  const ctx = { get(name) {
    if (name === 'credentials') return { resolve: async ref => { credentialRefs.push(ref); return { value: 'fixture-secret' }; } };
    if (name === 'connection') return { requestRejection: ({ headers }) => headers.authorization === 'fixture-auth' ? undefined : 401 };
    touched.push(name); return undefined;
  } };
  const services = createHostServices(ctx, directory, { config: { ...saved }, generate: () => assert.fail('Must not call a text model'),
    realtime: { socketFactory: async () => { const socket = new Socket(); sockets.push(socket); return socket; } }, ...options });
  t.after(() => services.close()); return { ctx, services, directory, sockets, credentialRefs, touched };
}

test('Host action uses saved official credentials without an interview or native session and persists no audio', async t => {
  const f = await hostFixture(t), before = await f.services.dispatch('state'), files = await readdir(f.directory);
  const pending = f.services.dispatch('realtime.test', {}, { requestId: 'probe-host-success' }); pending.catch(() => {});
  await tick(); await ready(f.sockets[0]); transcript(f.sockets[0]); audio(f.sockets[0]); done(f.sockets[0]); const result = await pending;
  assert.equal(result.ok, true); assert.deepEqual(f.credentialRefs, [config.credentialRef]);
  assert.deepEqual(await f.services.dispatch('state'), before); assert.deepEqual(await readdir(f.directory), files);
  assert.equal(f.touched.some(name => ['sessions', 'sessionPersistence', 'workspaceRegistry', 'speechToText', 'speechController', 'llm'].includes(name)), false);
  released(f.sockets[0]);
});

test('Host exposes BUSY, task.cancel and shutdown cleanup for probes and rejects work after close', async t => {
  const f = await hostFixture(t); const pending = f.services.dispatch('realtime.test', {}, { requestId: 'probe-cancel' });
  const rejected = assert.rejects(pending, { code: 'cancelled' }); await tick(); await ready(f.sockets[0]);
  await assert.rejects(f.services.dispatch('realtime.test', {}, { requestId: 'probe-busy' }), { code: 'BUSY' });
  assert.deepEqual(await f.services.dispatch('task.cancel', { requestId: 'probe-cancel' }), { cancelled: true }); await rejected; released(f.sockets[0]);
  const another = f.services.dispatch('realtime.test', {}, { requestId: 'probe-close' }), closed = assert.rejects(another, { code: 'cancelled' });
  await tick(); await f.services.close(); await closed; released(f.sockets[1]);
  await assert.rejects(f.services.dispatch('realtime.test'), { code: 'PLUGIN_CLOSED' });
});

test('Host refuses disabled or malformed saved settings and absent official credentials before opening transport', async t => {
  for (const [settings, code] of [[{}, 'not-configured'], [{ ...saved, realtimeWorkspace: 'invalid/workspace' }, 'invalid-config']]) {
    const f = await hostFixture(t, { config: settings }); await assert.rejects(f.services.dispatch('realtime.test'), { code }); assert.equal(f.sockets.length, 0);
  }
  const f = await hostFixture(t, { realtime: { resolveCredential: () => undefined, socketFactory: () => assert.fail('No secret, no socket') } });
  await assert.rejects(f.services.dispatch('realtime.test'), { code: 'credential-unavailable' });
});

class Response extends EventEmitter {
  writableEnded = false; destroyed = false; headersSent = false; status = null; body = '';
  writeHead(status) { this.status = status; this.headersSent = true; }
  end(body = '') { this.body += body; this.writableEnded = true; }
}
async function request(handler, headers, body = { action: 'realtime.test', input: {} }) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.url = '/zhijing/api';
  req.headers = { 'content-type': 'application/json', ...headers };
  const res = new Response(); await handler(req, res); return { status: res.status, body: JSON.parse(res.body) };
}

test('existing authenticated same-origin API gate protects the new test action before any credential resolution', async t => {
  const f = await hostFixture(t, { config: {} }), handler = createRequestHandler(f.ctx, f.services);
  assert.equal((await request(handler, {})).status, 401);
  assert.equal((await request(handler, { authorization: 'fixture-auth', 'sec-fetch-site': 'cross-site' })).status, 403);
  const allowed = await request(handler, { authorization: 'fixture-auth', 'sec-fetch-site': 'same-origin' });
  assert.equal(allowed.status, 409); assert.equal(allowed.body.error.code, 'not-configured');
  assert.equal(f.credentialRefs.length, 0); assert.equal(f.sockets.length, 0);
});

test('safe provider error statuses survive probe and Host HTTP layers without raw response details', async t => {
  for (const [statusCode, code, publicStatus] of [[401, 'authentication-failed', 502], [403, 'access-denied', 502],
    [404, 'endpoint-unavailable', 502], [429, 'rate-limited', 429], [503, 'provider-unavailable', 503], [418, 'connection-failed', 502]]) {
    const f = await hostFixture(t), handler = createRequestHandler(f.ctx, f.services);
    const pending = request(handler, { authorization: 'fixture-auth', 'sec-fetch-site': 'same-origin' });
    await tick(); const socket = f.sockets[0]; assert(socket);
    socket.emit('unexpected-response', { headers: { Authorization: 'Bearer fixture-secret' } },
      { statusCode, statusMessage: 'fixture-secret', headers: { 'set-cookie': 'fixture-secret' }, body: 'private response' });
    const result = await pending;
    assert.equal(result.status, publicStatus); assert.equal(result.body.ok, false); assert.equal(result.body.error.code, code);
    assert(!JSON.stringify(result).includes('fixture-secret')); assert(!JSON.stringify(result).includes('private response'));
    assert.equal(socket.sent.length, 0); released(socket);
  }
});
