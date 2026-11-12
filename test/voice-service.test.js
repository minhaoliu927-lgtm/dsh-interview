import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceService, decodeRecording } from '../src/voice/service.js';
import { encodeWave } from '../client/voice/controller.js';

const wav = () => Buffer.from(encodeWave(new Float32Array(1600))).toString('base64');
const snapshot = (phase = 'ready') => ({ selection: { providerId: 'host-selected', language: 'zh' },
  providers: [{ id: 'host-selected', name: 'Host selected recognizer', languages: ['auto', 'zh'], location: 'host-local', preparation: { phase } }] });
function registry(transcribe = async () => ({ text: '原始转写' })) {
  return { snapshot: () => snapshot(), resolve: input => ({ ...input, provider: { info: { id: input.providerId } } }), transcribe };
}

test('official speechController owns recognition selection and limits; no separate settings or synthesis API exists', async () => {
  const requests = [];
  const speechController = { catalog: () => ({ ...snapshot(), maxAudioBytes: 100000, maxDurationSeconds: 2 }),
    transcribe: async (input, signal) => { requests.push(input); assert.equal(signal.aborted, false); return { text: '  原文\r\n保留  ' }; } };
  const voice = createVoiceService({ speechController });
  const capabilities = await voice.catalog();
  assert.equal(capabilities.asr.providerId, 'host-selected'); assert.equal(capabilities.asr.available, true);
  assert.equal(capabilities.maxDurationSeconds, 2); assert.equal(capabilities.maxAudioBytes, 100000); assert.equal(capabilities.tts.available, false);
  assert.equal(voice.saveSettings, undefined); assert.equal(voice.synthesize, undefined);
  const result = await voice.transcribe({ audioBase64: wav() });
  assert.equal(result.text, '  原文\r\n保留  '); assert.equal(result.audioSeconds, .1);
  assert.deepEqual(requests[0], { audioBase64: wav(), providerId: 'host-selected', language: 'zh' });
});

test('registry-only Host uses its current named provider with no cloud fallback or key lookup', async () => {
  let received;
  const host = registry(async (spec, signal) => { received = spec; assert.equal(signal.aborted, false); return { text: '本地识别' }; });
  const voice = createVoiceService({ speechToText: () => host });
  const result = await voice.transcribe({ audioBase64: wav() });
  assert.equal(received.language, 'zh'); assert.equal(received.audio.subarray(0, 4).toString(), 'RIFF');
  assert.equal(result.providerId, 'host-selected');
  await assert.rejects(voice.transcribe({ audioBase64: wav(), baseURL: 'https://example.test', credentialRef: 'OTHER_KEY' }), { code: 'host-managed' });
});

test('missing and unprepared Host recognition remain genuinely unavailable without automatic preparation', async () => {
  const absent = createVoiceService(); assert.equal((await absent.catalog()).asr.available, false);
  await assert.rejects(absent.transcribe({ audioBase64: wav() }), { code: 'host-asr-unavailable' });
  const host = registry(() => assert.fail('unprepared recognizer')); host.snapshot = () => snapshot('unprepared');
  host.prepare = () => assert.fail('no automatic model download');
  const voice = createVoiceService({ speechToText: host });
  assert.equal((await voice.catalog()).asr.reasonCode, 'host-asr-not-ready');
  await assert.rejects(voice.transcribe({ audioBase64: wav() }), { code: 'host-asr-unavailable' });
});

test('malformed, overlong and oversized PCM is refused before invoking the Host', async () => {
  const host = registry(() => assert.fail('invalid audio reached Host'));
  const voice = createVoiceService({ speechToText: host });
  for (const audioBase64 of ['bad-base64', Buffer.from('not a WAV').toString('base64'), wav().slice(0, -2)]) {
    await assert.rejects(voice.transcribe({ audioBase64 }), { code: 'invalid-audio' });
  }
  const wrongRate = Buffer.from(wav(), 'base64'); wrongRate.writeUInt32LE(48000, 24);
  assert.throws(() => decodeRecording(wrongRate.toString('base64')), { code: 'invalid-audio' });
  assert.throws(() => decodeRecording(wav(), { maxAudioBytes: 100, maxDurationSeconds: 120 }), { code: 'invalid-audio' });
  assert.throws(() => decodeRecording(wav(), { maxAudioBytes: 100000, maxDurationSeconds: .01 }), { code: 'invalid-audio' });
});

test('provider errors and invalid responses expose no credential, native path or raw transport details', async () => {
  const voice = createVoiceService({ speechToText: registry(async () => { throw new Error('private credential and native path'); }) });
  await assert.rejects(voice.transcribe({ audioBase64: wav() }), error => error.code === 'host-unavailable' && !error.message.includes('private'));
  for (const text of ['', ' '.repeat(10), 'x'.repeat(16001)]) {
    await assert.rejects(createVoiceService({ speechToText: registry(async () => ({ text })) }).transcribe({ audioBase64: wav() }), { code: 'empty-transcript' });
  }
});

test('cancellation and bounded timeout reach the Host and discard nonsettling responses', async () => {
  const signals = [];
  const voice = createVoiceService({ requestTimeoutMs: 40, speechToText: registry((_spec, signal) => { signals.push(signal); return new Promise(() => {}); }) });
  const controller = new AbortController();
  const pending = voice.transcribe({ audioBase64: wav() }, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { code: 'cancelled' }); assert.equal(signals[0].aborted, true);
  const timer = setTimeout(() => {}, 100);
  try { await assert.rejects(voice.transcribe({ audioBase64: wav() }), { code: 'timeout' }); }
  finally { clearTimeout(timer); }
  assert.equal(signals[1].aborted, true);
});
