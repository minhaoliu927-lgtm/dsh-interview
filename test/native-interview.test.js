import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCareerTools, parseInterviewRequest } from '../src/tools.js';
import { interviewPrompt, submitNativePrompt } from '../client/native-interview.js';
import { zh, en } from '../locale/dictionaries.js';

const translate = dictionary => (key, params = {}) => dictionary[key].replace(/\{([^}]+)\}/g, (_all, name) => params[name]);
const signal = new AbortController().signal;
function harness() {
  const tools = new Map(), calls = [], listeners = new Map();
  const context = { sessionId: 'native-session', kind: 'interview', goalId: 'frozen-goal', materials: [{ id: 'resume-v1', kind: 'resume' }, { id: 'job-v1', kind: 'job' }] };
  const state = { interviews: [] };
  registerCareerTools({ tools: { register: tool => tools.set(tool.name, tool) }, on(name, callback) { listeners.set(name, callback); } }, async (action, input, options) => {
    calls.push({ action, input, options });
    if (action === 'conversation.context') return context;
    if (action === 'state') return state;
    if (action === 'interview.start') { const value = { id: 'interview-1', ...input, status: 'active' }; state.interviews.push(value); return value; }
    return { id: input.interviewId, ...input, action };
  });
  const session = { id: 'native-session', append() { throw new Error('Tools must never write native history'); } };
  const exec = { agent: { session, sessionId: 'wrong-legacy-field' }, signal };
  const emit = (type, data, subject = session) => listeners.get('session/event')(subject, { type, data });
  const user = (text, kind = 'user') => emit('user/message', { id: 'human-message', source: { kind }, content: [{ type: 'text', text }] });
  const request = text => { emit('turn/start', { turn: 1 }); user(text); };
  const run = (action, input = {}, execution = exec) => tools.get('zhijing_interview').execute({ action, input }, execution);
  return { tools, calls, context, state, session, exec, emit, user, request, run };
}

test('bilingual visible requests round-trip controls and preserve the exact reviewed answer', () => {
  for (const dictionary of [zh, en]) {
    const t = translate(dictionary);
    for (const language of ['zh', 'en']) for (const questionCount of [1, 5, 10]) {
      assert.deepEqual(parseInterviewRequest(interviewPrompt('interview.start', { language, questionCount }, t)), { action: 'interview.start', language, questionCount });
    }
    for (const action of ['interview.pause', 'interview.resume', 'interview.finish']) assert.deepEqual(parseInterviewRequest(interviewPrompt(action, {}, t)), { action });
    const text = '  我负责需求整理。\n\nI measured 23% — not 25%.\r\n';
    for (const questionNumber of [1, 2, 20]) assert.deepEqual(parseInterviewRequest(interviewPrompt('interview.answer', { text, questionNumber }, t)), { action: 'interview.answer', text, questionNumber });
    assert.throws(() => interviewPrompt('interview.answer', { text }, t), { code: 'QUESTION_CHANGED' });
  }
  assert.throws(() => parseInterviewRequest('please invent an answer'), { code: 'INTERVIEW_USER_REQUEST_REQUIRED' });
  for (const old of ['提交本题回答\n\n原话', 'Submit my answer to this question\n\nanswer', '提交第 0 题回答\n\n原话', 'Submit my answer to question 21\n\nanswer']) {
    assert.throws(() => parseInterviewRequest(old), { code: 'INTERVIEW_USER_REQUEST_REQUIRED' });
  }
});

test('start takes the real Agent session, immutable context and human-selected settings', async () => {
  const h = harness();
  h.request('Please start a mock interview in Chinese with 3 main questions.');
  const result = await h.run('interview.start', { language: 'en', questionCount: 10 });
  assert.equal(result.sessionId, 'native-session'); assert.equal(result.versionId, 'resume-v1'); assert.equal(result.goalId, 'frozen-goal');
  assert.equal(result.language, 'zh'); assert.equal(result.questionCount, 3);
  assert.equal(h.calls.filter(row => row.action === 'interview.start').length, 1);
  assert(h.calls.every(row => row.options.sessionId === 'native-session'));
});

test('tools reject spoofed sessions, material versions and cross-session interview IDs', async () => {
  const h = harness(); h.request('请开始中文模拟面试，共 5 个主要问题。');
  await assert.rejects(h.run('interview.start', { sessionId: 'other' }), { code: 'INTERVIEW_SESSION_MISMATCH' });
  await assert.rejects(h.run('interview.start', { goalId: 'other' }), { code: 'INTERVIEW_CONTEXT_MISMATCH' });
  await assert.rejects(h.run('interview.start', { versionId: 'resume-v2' }), { code: 'INTERVIEW_CONTEXT_MISMATCH' });
  await assert.rejects(h.run('interview.start', {}, { agent: { sessionId: 'native-session' }, signal }), { code: 'NATIVE_SESSION_REQUIRED' });
  h.state.interviews.push({ id: 'owned-interview', sessionId: 'native-session' }, { id: 'other-interview', sessionId: 'other' });
  h.request('提交第 1 题回答\n\n原话');
  await assert.rejects(h.run('interview.answer', { interviewId: 'other-interview' }), { code: 'INTERVIEW_SESSION_MISMATCH' });
  assert.equal(h.calls.filter(row => row.action.startsWith('interview.')).length, 0);
});

test('only the current unique human turn can authorize an interview action', async () => {
  const h = harness(), text = '请开始中文模拟面试，共 5 个主要问题。';
  await assert.rejects(h.run('interview.start'), { code: 'INTERVIEW_USER_REQUEST_REQUIRED' });
  h.emit('turn/start', { turn: 1 }); h.user(text, 'runtime-context'); h.user(text, 'plugin');
  await assert.rejects(h.run('interview.start'), { code: 'INTERVIEW_USER_REQUEST_REQUIRED' });
  h.user(text); await h.run('interview.start');
  h.emit('turn/end', { turn: 1 });
  await assert.rejects(h.run('interview.start'), { code: 'INTERVIEW_USER_REQUEST_REQUIRED' });
  h.request(text); h.user('a second queued human message');
  await assert.rejects(h.run('interview.start'), { code: 'INTERVIEW_USER_REQUEST_REQUIRED' });
});

test('answer is copied from the human message, cannot be rewritten, and repeated model calls mutate once', async () => {
  const h = harness(); h.state.interviews.push({ id: 'i1', sessionId: 'native-session', currentQuestionId: 'q1', questions: [{ id: 'q1', answer: null }] });
  const text = '  实际结果为 19%。\n不是 30%。 ';
  h.request(`提交第 1 题回答\n\n${text}`);
  await assert.rejects(h.run('interview.answer', { text: text.trim() }), { code: 'INTERVIEW_ANSWER_MISMATCH' });
  const [one, two] = await Promise.all([h.run('interview.answer'), h.run('interview.answer', { text })]);
  assert.deepEqual(one, two);
  const mutations = h.calls.filter(row => row.action === 'interview.answer');
  assert.equal(mutations.length, 1); assert.equal(mutations[0].input.text, text);
  assert.equal(mutations[0].input.questionId, 'q1');
  h.state.interviews[0].currentQuestionId = 'q2';
  h.state.interviews[0].questions.push({ id: 'q2', answer: null });
  assert.deepEqual(await h.run('interview.answer'), one, 'A retry in the same turn must return the first result even after advancing the question');
});

test('start and control requests cannot become answers; ordinary discussion cannot be saved', async () => {
  const h = harness(); h.state.interviews.push({ id: 'i1', sessionId: 'native-session' });
  for (const text of ['请暂停这场模拟面试。', 'Please finish this mock interview and create the report.', '请开始中文模拟面试，共 5 个主要问题。']) {
    h.request(text); await assert.rejects(h.run('interview.answer', { text }), { code: 'INTERVIEW_REQUEST_MISMATCH' });
  }
  h.request('Can you give an example answer?');
  await assert.rejects(h.run('interview.answer'), { code: 'INTERVIEW_USER_REQUEST_REQUIRED' });
  assert.equal(h.calls.filter(row => row.action === 'interview.answer').length, 0);
});

test('context tool reports only the interview attached to the actual native session', async () => {
  const h = harness(); h.state.interviews.push({ id: 'foreign', sessionId: 'other' }, { id: 'own', sessionId: 'native-session' });
  const result = await h.tools.get('zhijing_context').execute({}, h.exec);
  assert.equal(result.interview.id, 'own'); assert.equal(result.sessionId, 'native-session');
  await assert.rejects(h.tools.get('zhijing_goals').execute({ action: 'conversation.link', input: { sessionId: 'other' } }, h.exec), { code: 'NATIVE_SESSION_REQUIRED' });
});

test('Agent views omit unsubmitted speech transcripts and use the actual session model selection', async () => {
  const h = harness();
  const selection = { provider: 'session-provider', model: 'session-model' };
  h.exec.agent.model = { current: () => selection };
  h.state.interviews.push({ id: 'own', sessionId: 'native-session', currentQuestionId: 'q2', questions: [{ id: 'q1', text: 'Question',
    speechDrafts: [{ rawTranscript: 'unsubmitted private speech' }], selectedSpeechReview: 'review-1', answer: { text: 'confirmed answer' } }] });
  h.state.interviews[0].questions.push({ id: 'q2', text: 'Followup', answer: null });
  const context = await h.tools.get('zhijing_context').execute({}, h.exec);
  assert(!JSON.stringify(context).includes('unsubmitted private speech'));
  assert.equal(context.interview.questions[0].answer.text, 'confirmed answer');
  h.request('请开始中文模拟面试，共 5 个主要问题。');
  assert(!JSON.stringify(await h.run('interview.start')).includes('speechDrafts'));
  h.request('提交第 2 题回答\n\nconfirmed answer');
  await h.run('interview.answer');
  assert.deepEqual(h.calls.find(row => row.action === 'interview.answer').options.modelSelection, selection);
});

test('queued answers keep their human-selected question number and cannot spill into the next question', async () => {
  const h = harness();
  const questions = [{ id: 'q1', kind: 'main', answer: { text: 'earlier answer' } }, { id: 'q2', kind: 'followup', answer: null }];
  h.state.interviews.push({ id: 'own', sessionId: 'native-session', currentQuestionId: 'q2', questions });
  h.request('提交第 1 题回答\n\n旧页面排队提交的原话');
  await assert.rejects(h.run('interview.answer'), { code: 'QUESTION_CHANGED' });
  await assert.rejects(h.run('interview.answer', { questionId: 'q2' }), { code: 'INTERVIEW_QUESTION_MISMATCH' });
  await assert.rejects(h.run('interview.answer', { questionNumber: 2 }), { code: 'INTERVIEW_QUESTION_MISMATCH' });
  assert.equal(questions[1].answer, null);
  assert.equal(h.calls.filter(row => row.action === 'interview.answer').length, 0);
  h.request('Submit my answer to question 2\n\nThis answer is for the followup.');
  await h.run('interview.answer');
  assert.equal(h.calls.find(row => row.action === 'interview.answer').input.questionId, 'q2');
  h.request('Submit my answer to question 3\n\nA future question is unavailable.');
  await assert.rejects(h.run('interview.answer'), { code: 'QUESTION_CHANGED' });
});

test('Agent material mutations expose metadata while body reads require one confirmed version', async () => {
  const tools = new Map(), calls = [];
  const version = { id: 'v1', revision: 1, confirmed: false, text: 'UNREVIEWED imported source body', source: { capturedText: 'PRIVATE source metadata' } };
  const material = { id: 'm1', title: 'Pending resume', kind: 'resume', latestVersionId: 'v1', versions: [version] };
  registerCareerTools({ tools: { register: tool => tools.set(tool.name, tool) }, on() {} }, async (action, input) => {
    calls.push({ action, input }); return action === 'material.get' ? version : material;
  });
  const tool = tools.get('zhijing_materials');
  for (const action of ['material.add', 'material.update', 'material.fetch']) {
    const result = await tool.execute({ action, input: action === 'material.fetch' ? { url: 'https://example.com/job', kind: 'job' } : { text: 'new text' } }, { signal });
    assert.equal(result.id, 'm1'); assert.equal(result.latestVersionId, 'v1'); assert.equal(result.versions[0].confirmed, false);
    assert(!JSON.stringify(result).includes('UNREVIEWED')); assert(!JSON.stringify(result).includes('PRIVATE')); assert.equal(result.versions[0].text, undefined);
  }
  const before = calls.length;
  await assert.rejects(tool.execute({ action: 'material.get', input: { materialId: 'm1' } }, { signal }), { code: 'MATERIAL_VERSION_REQUIRED' });
  assert.equal(calls.length, before);
  await assert.rejects(tool.execute({ action: 'material.get', input: { versionId: 'v1' } }, { signal }), { code: 'MATERIAL_NOT_CONFIRMED' });
  version.confirmed = true;
  assert.equal((await tool.execute({ action: 'material.get', input: { versionId: 'v1' } }, { signal })).text, version.text);
});

test('native submission uses DSH admission and its echo identity, with reference release', async () => {
  const calls = []; let released = false;
  const session = { beginSubmission(input) { calls.push(input); return { requestId: 'echo-1', abandon() { throw new Error('Already submitted'); } }; },
    async prompt(...args) { calls.push(args); return { ok: true, value: { accepted: true } }; } };
  const sessions = { async using(id, options, operation) { assert.equal(id, 'session-1'); assert.equal(options.source, 'zhijingChat'); try { return await operation({ ready: Promise.resolve({ session }) }); } finally { released = true; } } };
  assert.deepEqual(await submitNativePrompt(sessions, 'session-1', 'exact text', signal), { accepted: true, sessionId: 'session-1' });
  assert.equal(released, true); assert.deepEqual(calls[0], { mode: 'queue', text: 'exact text', attachments: [] });
  assert.deepEqual(calls[1], [[{ type: 'text', text: 'exact text' }], 'queue', signal, 'echo-1']);
});

test('native refusal and acquisition failures fail explicitly without HTTP or fabricated history', async () => {
  await assert.rejects(submitNativePrompt({}, 's1', 'text'), { code: 'NATIVE_PROMPT_UNAVAILABLE' });
  let released = false;
  const sessions = { async using(_id, _options, operation) { try { return await operation({ ready: Promise.resolve({ session: {
    beginSubmission() { return { requestId: 'r1', abandon() {} }; }, async prompt() { return { ok: false, error: { code: 'MODEL_UNAVAILABLE', message: 'Choose a model' } }; },
  } }) }); } finally { released = true; } } };
  await assert.rejects(submitNativePrompt(sessions, 's1', 'text'), { code: 'MODEL_UNAVAILABLE' }); assert.equal(released, true);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(submitNativePrompt(sessions, 's1', 'text', aborted.signal), { name: 'AbortError' });
});
