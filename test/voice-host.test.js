import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHostServices } from '../src/host.js';
import { encodeWave } from '../client/voice/controller.js';

const wave = Buffer.from(encodeWave(new Float32Array(1600))).toString('base64');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function setup(t, recognize) {
  const base = resolve('.runtime/tests/voice-host'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'case-'));
  let calls = 0;
  const speechToText = { snapshot: () => ({ selection: { providerId: 'test-asr' }, providers: [{ id: 'test-asr', preparation: { phase: 'ready' } }] }),
    resolve: request => ({ ...request, provider: { info: { id: 'test-asr' } } }),
    transcribe: async (spec, signal) => { calls++; return recognize(spec, signal); } };
  const services = createHostServices({ get: name => name === 'speechToText' ? speechToText : undefined }, directory, {
    generate: async ({ task, input }) => {
      if (task !== 'interview.start') throw Object.assign(new Error('Synthetic model unavailable after the answer is saved'), { code: 'MODEL_FAILED' });
      const job = input.snapshots.find(row => row.kind === 'job');
      return { result: { question: { text: '请说明你的测试经历。', competency: '测试', evidence: [{ sourceId: job.id, quote: job.text, start: 0, end: job.text.length }] } },
        model: { provider: 'fixture', model: 'local' } };
    },
  });
  t.after(() => services.close());
  const goal = await services.dispatch('goal.create', { title: '合成测试岗位' });
  let versionId;
  for (const kind of ['resume', 'job']) {
    const material = await services.dispatch('material.add', { title: kind, kind, text: kind === 'resume' ? '负责合成项目的自动化测试。' : '岗位要求自动化测试经验。' });
    await services.dispatch('material.confirm', { versionId: material.latestVersionId });
    await services.dispatch('goal.linkMaterial', { goalId: goal.id, versionId: material.latestVersionId });
    if (kind === 'resume') versionId = material.latestVersionId;
  }
  const sessionId = 'synthetic-interview';
  await services.dispatch('conversation.link', { goalId: goal.id, versionId, sessionId, kind: 'interview' });
  const interview = await services.dispatch('interview.start', { goalId: goal.id, versionId, sessionId, language: 'zh', questionCount: 1 });
  const input = { interviewId: interview.id, questionId: interview.currentQuestionId, audioBase64: wave };
  return { services, directory, input, calls: () => calls, question: async () => (await services.dispatch('state')).interviews[0].questions[0] };
}

test('host persists real ASR origin separately from user review and final answer without saving audio', async t => {
  const raw = '  原始识别\r\n十个测试  ';
  const { services, directory, input, question } = await setup(t, async () => ({ text: raw }));
  await assert.rejects(services.dispatch('interview.voiceTranscript', { ...input, transcript: 'forged' }), { code: 'VOICE_TRANSCRIPT_INTERNAL' });
  const response = await services.dispatch('voice.transcribe', input);
  assert.equal(response.text, raw); assert.equal(response.providerId, 'test-asr'); assert.equal(response.audioSeconds, 0.1);
  let current = await question();
  assert.equal(current.answer, null); assert.equal(current.speechDrafts[0].rawTranscript, raw);
  assert.equal(current.speechDrafts[0].id, response.speechDraftId);
  const text = '  最终确认九个测试\r\n原样保留  ';
  const review = await services.dispatch('interview.voiceReview', { ...input, speechDraftId: response.speechDraftId, editedTranscript: '修订为九个测试', finalText: text });
  assert.equal(review.reviewed, true);
  await assert.rejects(services.dispatch('interview.answer', { interviewId: input.interviewId, questionId: input.questionId, text }));
  current = await question();
  assert.equal(current.answer.text, text); assert.equal(current.answer.speechDraftId, response.speechDraftId);
  assert.equal(current.answer.speechReviewId, review.speechReviewId); assert.equal(current.speechDrafts[0].rawTranscript, raw);
  assert.equal((await readdir(directory)).some(name => /\.(wav|mp3|webm)$/.test(name)), false);
});

test('host rejects invalid questions before ASR and refuses late results even after resuming the same question', async t => {
  const response = deferred(), entered = deferred();
  const { services, input, calls, question } = await setup(t, async () => { entered.resolve(); return response.promise; });
  await assert.rejects(services.dispatch('voice.transcribe', { ...input, questionId: 'another-question' }), { code: 'VOICE_QUESTION_CHANGED' });
  assert.equal(calls(), 0);
  const pending = services.dispatch('voice.transcribe', input); await entered.promise;
  await services.dispatch('interview.pause', { interviewId: input.interviewId });
  await services.dispatch('interview.resume', { interviewId: input.interviewId });
  response.resolve({ text: '迟到结果不能成为草稿' });
  await assert.rejects(pending, { code: 'VOICE_QUESTION_CHANGED' });
  assert.equal((await question()).speechDrafts, undefined);
});

test('cancelling ASR prevents a late supplier response from creating a persisted draft', async t => {
  const response = deferred(), entered = deferred();
  const { services, input, question } = await setup(t, async () => { entered.resolve(); return response.promise; });
  const abort = new AbortController();
  const pending = services.dispatch('voice.transcribe', input, { signal: abort.signal });
  await entered.promise; abort.abort();
  const failed = assert.rejects(pending, { code: 'cancelled' });
  response.resolve({ text: '取消后的迟到结果' }); await failed;
  assert.equal((await question()).speechDrafts, undefined);
});
