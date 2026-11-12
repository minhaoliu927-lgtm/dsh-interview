import test from 'node:test';
import assert from 'node:assert/strict';
import { createPcm16Encoder, createRealtimeMedia } from '../client/voice/realtime-media.js';

test('PCM keeps duration and samples across fractional 44.1k frame boundaries', () => {
  const encode = createPcm16Encoder(44100), parts = [];
  for (let offset = 0; offset < 44100; offset += 128) parts.push(encode(new Float32Array(Math.min(128, 44100 - offset)).fill(.5)));
  const result = Buffer.concat(parts);
  assert.equal(result.length, 32000);
  for (let i = 0; i < result.length; i += 2) assert.equal(result.readInt16LE(i), 16384);
});
test('PCM clips extrema and does not let nonfinite values become noise', () => {
  const result = createPcm16Encoder(16000)(new Float32Array([-2, 2, NaN, 0]));
  assert.deepEqual([...new Int16Array(result.buffer)], [-32768, 32767, 0, 0]);
});
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  let stopped = 0, closed = 0, revoked = 0, playbackStops = 0;
  const sent = [], nodes = [], listeners = new Map();
  const track = { enabled: true, stop() { stopped++; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const capture = { port: { onmessage: null, close() {} }, connect() {}, disconnect() {} };
  const context = { sampleRate: 48000, currentTime: 0, destination: {}, audioWorklet: { async addModule() {} }, async resume() {}, async close() { closed++; },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), createGain: () => ({ gain: {}, connect() {}, disconnect() {} }),
    createBuffer: (_channels, count) => ({ getChannelData: () => new Float32Array(count) }),
    createBufferSource: () => { const node = { connect() {}, disconnect() {}, start() {}, stop() { playbackStops++; } }; nodes.push(node); return node; } };
  const documentImpl = { hidden: false, addEventListener: (name, cb) => listeners.set(name, cb), removeEventListener: name => listeners.delete(name) };
  const media = createRealtimeMedia({ sendAudio: async input => sent.push(input), mediaDevices: { getUserMedia: async () => stream }, createAudioContext: () => context,
    createCaptureNode: () => capture, documentImpl, urlApi: { createObjectURL: () => 'blob:owned', revokeObjectURL() { revoked++; } }, ...options });
  return { media, capture, stream, track, documentImpl, listeners, sent, nodes, facts: () => ({ stopped, closed, revoked, playbackStops }) };
}
test('continuous capture sends bounded PCM and mute never sends additional audio', async () => {
  const f = fixture(); await f.media.start();
  f.capture.port.onmessage({ data: new Float32Array(4800).fill(.25) }); await tick();
  assert.equal(f.sent.length, 1); assert.equal(Buffer.from(f.sent[0].audioBase64, 'base64').length, 3200);
  f.media.setMuted(true); assert.equal(f.track.enabled, false);
  f.capture.port.onmessage({ data: new Float32Array(4800).fill(.25) }); await tick(); assert.equal(f.sent.length, 1);
  await f.media.close(); assert.equal(f.facts().stopped, 1); assert.equal(f.facts().closed, 1); assert.equal(f.listeners.size, 0);
});
test('closing while permission is pending stops the late microphone without starting audio', async () => {
  let grant; const f = fixture({ mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } });
  const starting = f.media.start(); await f.media.close(); grant(f.stream); await starting;
  assert.equal(f.facts().stopped, 1); assert.equal(f.facts().closed, 0); assert.equal(f.media.snapshot().phase, 'closed');
});
test('interrupt stops owned playback and refuses packets from the cancelled playback epoch', async () => {
  const f = fixture(); await f.media.start(); const epoch = f.media.playbackEpoch;
  const audioBase64 = Buffer.alloc(4800).toString('base64');
  assert.equal(f.media.play({ audioBase64, epoch }), true); f.media.interrupt();
  assert.equal(f.facts().playbackStops, 1); assert.equal(f.media.play({ audioBase64, epoch }), false);
  assert.equal(f.media.play({ audioBase64, epoch: f.media.playbackEpoch }), true);
  await f.media.close(); assert.equal(f.facts().playbackStops, 2);
});
test('backpressure stops capture rather than silently losing part of an answer', async () => {
  const f = fixture({ maxQueuedFrames: 1, sendAudio: (_input, { signal }) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) });
  await f.media.start();
  f.capture.port.onmessage({ data: new Float32Array(4800) });
  f.capture.port.onmessage({ data: new Float32Array(9600) }); await tick();
  assert.equal(f.media.snapshot().error, 'audio-backpressure'); assert.equal(f.facts().stopped, 1);
});
test('page hidden releases microphone, playback and visibility listener', async () => {
  const f = fixture(); await f.media.start(); f.documentImpl.hidden = true; f.listeners.get('visibilitychange')(); await tick();
  assert.equal(f.media.snapshot().phase, 'closed'); assert.equal(f.facts().stopped, 1); assert.equal(f.listeners.size, 0);
});
test('explicit finish immediately stops devices and flushes queued PCM plus a sub-frame tail in order', async () => {
  let release; const sent = [];
  const f = fixture({ sendAudio: async input => { sent.push(input); if (sent.length === 1) await new Promise(resolve => { release = resolve; }); } });
  await f.media.start();
  f.capture.port.onmessage({ data: new Float32Array(7200).fill(.25) });
  const finishing = f.media.finishCapture();
  assert.equal(f.facts().stopped, 1); assert.equal(f.capture.port.onmessage, null);
  release(); await finishing;
  assert.deepEqual(sent.map(row => [row.seq, Buffer.from(row.audioBase64, 'base64').length]), [[0, 3200], [1, 1600]]);
  assert.equal(f.facts().closed, 1); assert.equal(f.facts().stopped, 1);
});
test('finish without captured samples does not send an empty frame', async () => {
  const f = fixture(); await f.media.start(); await f.media.finishCapture();
  assert.equal(f.sent.length, 0); assert.equal(f.facts().stopped, 1);
});
test('a stalled final frame reports incomplete capture and releases the transport scope', async () => {
  let aborted = false;
  const f = fixture({ flushTimeoutMs: 10, sendAudio: (_input, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })) });
  await f.media.start(); f.capture.port.onmessage({ data: new Float32Array(2400) });
  await assert.rejects(f.media.finishCapture(), { code: 'audio-flush-incomplete' });
  assert.equal(aborted, true); assert.equal(f.facts().closed, 1); assert.equal(f.facts().stopped, 1);
});
