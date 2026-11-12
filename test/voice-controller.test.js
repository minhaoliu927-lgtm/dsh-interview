import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController } from '../client/voice/controller.js';
import { submitReviewedVoiceAnswer } from '../client/voice/review.js';

const catalog = { asr: { available: true }, tts: { available: true }, maxDurationSeconds: 120, maxAudioBytes: 4194304 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function environment() {
  const counts = { stopped: 0, closed: 0, cancelled: 0, spoken: 0, acquired: 0 };
  const stream = { getTracks: () => [{ stop: () => { counts.stopped++; }, addEventListener() {} }] };
  const env = { setInterval, clearInterval, setTimeout, clearTimeout,
    navigator: { mediaDevices: { getUserMedia: async () => { counts.acquired++; return stream; } } },
    MediaRecorder: class {
      state = 'inactive'; mimeType = 'audio/webm';
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['fixture']) }); this.onstop?.(); }); }
    },
    AudioContext: class { state = 'running'; async close() { this.state = 'closed'; counts.closed++; } async decodeAudioData() { return { duration: .01 }; } },
    OfflineAudioContext: class { createBufferSource() { return { connect() {}, start() {} }; } async startRendering() { return { getChannelData: () => new Float32Array(160) }; } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    voices: [{ name: 'Synthetic local voice', lang: 'zh-CN', localService: true }],
    voiceListeners: new Set(),
  };
  env.speechSynthesis = { speaking: false, pending: false, getVoices: () => env.voices,
    speak(utterance) { counts.spoken++; this.speaking = true; env.lastUtterance = utterance; },
    cancel() { counts.cancelled++; this.speaking = false; },
    addEventListener(name, fn) { if (name === 'voiceschanged') env.voiceListeners.add(fn); },
    removeEventListener(name, fn) { if (name === 'voiceschanged') env.voiceListeners.delete(fn); },
  };
  return { env, counts, stream };
}

test('recording produces an editable transcript and never submits it automatically', async () => {
  const { env, counts } = environment(); let sent = 0;
  const voice = createVoiceController({ environment: env, api: { catalog: async () => catalog, transcribe: async ({ audioBase64 }) => {
    sent++; assert.equal(Buffer.from(audioBase64, 'base64').subarray(0, 4).toString(), 'RIFF'); return { text: '原始转写' };
  } } });
  await voice.startRecording(); assert.equal(voice.getState().phase, 'recording');
  await voice.stopRecording(); assert.equal(voice.getState().transcript, '原始转写');
  voice.setTranscript('用户确认的修改'); assert.equal(voice.takeTranscript(), '用户确认的修改');
  assert.equal(voice.getState().transcript, ''); assert.equal(sent, 1);
  await voice.dispose(); assert.ok(counts.stopped > 0); assert.equal(counts.closed, 1);
});

test('cancelling a pending permission prompt releases a late microphone grant', async () => {
  const { env, stream, counts } = environment(); const permission = deferred();
  env.navigator.mediaDevices.getUserMedia = () => permission.promise;
  const voice = createVoiceController({ environment: env, api: { catalog: async () => catalog } });
  const pending = voice.startRecording(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(voice.getState().phase, 'requesting'); voice.cancel(); permission.resolve(stream); await pending;
  assert.equal(voice.getState().phase, 'idle'); assert.equal(counts.stopped, 1);
  await voice.dispose();
});

test('late ASR result after cancellation cannot overwrite an existing transcript', async () => {
  const { env } = environment(); const response = deferred(); let signal;
  const voice = createVoiceController({ environment: env, api: { catalog: async () => catalog, transcribe: (_input, options) => { signal = options.signal; return response.promise; } } });
  voice.setTranscript('已保留的回答'); await voice.startRecording(); const pending = voice.stopRecording();
  await new Promise(resolve => setImmediate(resolve)); voice.cancel();
  assert.equal(signal.aborted, true); response.resolve({ text: '迟到结果' }); await pending;
  assert.equal(voice.getState().transcript, '已保留的回答'); await voice.dispose();
});

test('starting a recording interrupts only the device speech owned by this controller', async () => {
  const { env, counts } = environment();
  const voice = createVoiceController({ environment: env, api: { catalog: async () => catalog } });
  await voice.speak('问题'); assert.equal(voice.getState().phase, 'playing');
  await voice.startRecording(); assert.equal(voice.getState().phase, 'recording');
  assert.equal(counts.cancelled, 1); assert.equal(counts.spoken, 1);
  await voice.dispose(); assert.equal(counts.closed, 1);
});

test('permission refusal is visible and does not prevent using a typed answer', async () => {
  const { env } = environment(); env.navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  const voice = createVoiceController({ environment: env, api: { catalog: async () => catalog } });
  await voice.startRecording(); assert.equal(voice.getState().phase, 'idle'); assert.match(voice.getState().error, /权限/);
  voice.setTranscript('文字回答'); assert.equal(voice.takeTranscript(), '文字回答'); await voice.dispose();
});

test('dispose stops owned local speech and removes its late event handlers', async () => {
  const { env, counts } = environment();
  const voice = createVoiceController({ environment: env, api: { catalog: async () => catalog } });
  await voice.speak('问题'); const ended = env.lastUtterance.onend;
  await voice.dispose(); ended();
  assert.equal(counts.cancelled, 1); assert.equal(voice.getState().phase, 'idle');
  assert.equal(env.lastUtterance.onend, null); assert.equal(env.voiceListeners.size, 0);
});

test('local voices arriving later update capability, while cloud and wrong-language voices remain unavailable', async () => {
  const { env, counts } = environment();
  env.voices = [{ name: 'Remote Chinese', lang: 'zh-CN', localService: false }, { name: 'Local English', lang: 'en-US', localService: true }];
  const voice = createVoiceController({ environment: env, language: 'zh', api: { catalog: async () => catalog } });
  await voice.refreshCatalog(); assert.equal(voice.getState().catalog.tts.available, false);
  await voice.speak('问题'); assert.equal(voice.getState().errorCode, 'device-voice-missing'); assert.equal(counts.spoken, 0);
  env.voices.push({ name: 'Local Chinese', lang: 'zh-CN', localService: true });
  for (const listener of env.voiceListeners) listener();
  assert.equal(voice.getState().catalog.tts.available, true);
  await voice.speak('本地问题'); assert.equal(env.lastUtterance.voice.name, 'Local Chinese'); assert.equal(env.lastUtterance.text, '本地问题');
  voice.stopPlayback(); assert.equal(counts.cancelled, 1); await voice.dispose();
});

test('another speech queue is not interrupted or joined by plugin playback', async () => {
  const { env, counts } = environment(); env.speechSynthesis.speaking = true;
  const voice = createVoiceController({ environment: env, api: { catalog: async () => catalog } });
  await voice.speak('问题'); assert.equal(voice.getState().errorCode, 'device-speech-busy');
  await voice.dispose(); assert.equal(counts.spoken, 0); assert.equal(counts.cancelled, 0);
});

test('the host locale can translate permission feedback using a stable code', async () => {
  const { env } = environment(); env.navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  const voice = createVoiceController({ environment: env, api: { catalog: async () => catalog }, translateError: ({ code }) => `translated:${code}` });
  await voice.startRecording(); assert.equal(voice.getState().errorCode, 'permission-denied');
  assert.equal(voice.getState().error, 'translated:permission-denied'); await voice.dispose();
});

test('a recorded answer keeps its question, untouched ASR text and separately edited text until explicit use', async () => {
  const { env } = environment(); const context = { interviewId: 'interview-1', questionId: 'question-1' };
  const raw = '  原始转写\r\n十个项目  ';
  const voice = createVoiceController({ environment: env, transcriptionContext: context, api: {
    catalog: async () => catalog, transcribe: async input => {
      assert.equal(input.interviewId, 'interview-1'); assert.equal(input.questionId, 'question-1');
      return { text: raw, speechDraftId: 'speech-1' };
    },
  } });
  context.questionId = 'mutated-outside-controller';
  await voice.startRecording(); await voice.stopRecording();
  voice.setTranscript('  用户修正为九个项目\n保留边界空格  ');
  const draft = voice.takeTranscriptDraft();
  assert.equal(draft.rawTranscript, raw); assert.equal(draft.speechDraftId, 'speech-1');
  assert.equal(draft.questionId, 'question-1'); assert.equal(draft.text, draft.editedTranscript);
  assert.equal(draft.text, '  用户修正为九个项目\n保留边界空格  ');
  assert.equal(voice.takeTranscriptDraft(), null); assert.equal(voice.getState().speechDraftId, null);
  await voice.dispose();
});

test('a late ASR draft after leaving its question cannot become another question answer', async () => {
  const { env } = environment(), response = deferred();
  const voice = createVoiceController({ environment: env, transcriptionContext: { interviewId: 'i1', questionId: 'q1' }, api: {
    catalog: async () => catalog, transcribe: () => response.promise,
  } });
  await voice.startRecording(); const pending = voice.stopRecording();
  await new Promise(resolve => setImmediate(resolve)); await voice.dispose();
  response.resolve({ text: '上一题迟到的转写', speechDraftId: 'speech-old' }); await pending;
  assert.equal(voice.getState().speechDraftId, null); assert.equal(voice.takeTranscriptDraft(), null);
});

test('a bound recording without a saved ASR identity is not offered as a confirmed voice draft', async () => {
  const { env } = environment();
  const voice = createVoiceController({ environment: env, transcriptionContext: { interviewId: 'i1', questionId: 'q1' }, api: {
    catalog: async () => catalog, transcribe: async () => ({ text: '未保存原文' }),
  } });
  await voice.startRecording(); await voice.stopRecording();
  assert.equal(voice.getState().errorCode, 'voice-draft-missing'); assert.equal(voice.takeTranscriptDraft(), null);
  await voice.dispose();
});

test('voice review is durable before native submission and preserves the exact final answer', async () => {
  const calls = [], input = { interviewId: 'i1', questionId: 'q1', speechDraftId: 'draft-1', editedTranscript: '修订转写', text: '  最终回答\r\n保留原文  ', rawTranscript: 'must not be writable from UI' };
  await submitReviewedVoiceAnswer({ api: { request: async (action, body) => {
    calls.push('review'); assert.equal(action, 'interview.voiceReview'); assert.equal(body.finalText, input.text);
    assert.equal(body.editedTranscript, input.editedTranscript); assert.equal(body.rawTranscript, undefined);
    return { interviewId: 'i1', questionId: 'q1', speechDraftId: 'draft-1', reviewed: true };
  } }, submit: async text => { calls.push('native'); assert.equal(text, input.text); } }, input);
  assert.deepEqual(calls, ['review', 'native']);
});

test('failed, mismatched or cancelled review cannot submit a native answer', async () => {
  const input = { interviewId: 'i1', questionId: 'q1', speechDraftId: 'draft-1', editedTranscript: '修订', text: '回答' };
  const submit = () => assert.fail('Native submission before a valid saved review');
  await assert.rejects(submitReviewedVoiceAnswer({ submit, api: { request: async () => { throw Object.assign(new Error('changed question'), { code: 'QUESTION_CHANGED' }); } } }, input), { code: 'QUESTION_CHANGED' });
  await assert.rejects(submitReviewedVoiceAnswer({ submit, api: { request: async () => ({ ...input, questionId: 'q2', reviewed: true }) } }, input), { code: 'VOICE_REVIEW_NOT_SAVED' });
  const aborted = new AbortController();
  await assert.rejects(submitReviewedVoiceAnswer({ submit, api: { request: async () => { aborted.abort(); return { ...input, reviewed: true }; } } }, input, aborted.signal), { name: 'AbortError' });
});

test('typed answers do not manufacture voice records', async () => {
  const text = '纯文字回答';
  const result = await submitReviewedVoiceAnswer({ api: { request: () => assert.fail('No ASR draft') }, submit: async value => value }, { text });
  assert.equal(result, text);
});
