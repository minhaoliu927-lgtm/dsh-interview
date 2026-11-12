import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createCareerService } from '../src/domain/index.js';
import { CAREER_MIGRATIONS } from '../src/domain/store.js';

const testRoot = path.resolve(process.env.ZHIJING_TEST_ROOT ?? fileURLToPath(new URL('../.runtime/tests/domain/', import.meta.url)));
const RESUME = '负责产品调研，访谈20名用户。\n整理需求文档。';
const JOB = '产品经理需要用户调研和需求文档经验。';
const cite = source => ({ sourceId: source.id, quote: source.text, start: 0, end: source.text.length });
const envelope = result => ({ result, model: { provider: 'fixture', model: 'deterministic-local' }, usage: { inputTokens: 10, outputTokens: 5 } });

function responder({ task, input }) {
  const sources = input.snapshots ?? [];
  if (task === 'assessment.run') return envelope({ criteria: input.rubric.map(row => ({ id: row.id, rating: 3,
    reason: '引用材料提供具体依据', evidence: sources.filter(source => ['resume', 'job'].includes(source.kind)).map(cite) })),
    suggestions: [{ text: '进一步说明调研方法', evidence: [cite(sources[0])] }], missing: [] });
  if (task === 'rewrite.run') return envelope({ items: [
    { before: '负责产品调研，访谈20名用户。', after: '访谈20名用户，完成产品调研。', reason: '将具体工作放在句首' },
    { before: '整理需求文档。', after: '编写并整理需求文档。', reason: '整理表达' },
  ] });
  if (task === 'rewrite.verify') return envelope({ items: input.items.map(item => ({ id: item.id, supported: true,
    reason: '措辞变化，事实来自输入', evidence: [cite(sources[0])] })) });
  if (task === 'interview.start') return envelope({ question: { text: '请说明一次用户调研的过程。', competency: '用户调研', evidence: [cite(sources.find(source => source.kind === 'job'))] } });
  if (task === 'interview.answer') {
    const current = input.currentQuestion;
    const answer = sources.find(source => source.id === current.answer.id);
    const type = input.allowedNext.includes('followup') ? 'followup' : input.allowedNext[0];
    return envelope({ evaluation: { rating: 3, reason: '回答包含用户自己的描述', evidence: [cite(answer)] },
      next: type === 'finish' ? { type } : { type, text: type === 'followup' ? '你怎样核对调研结果？' : '请说明你如何整理需求。',
        competency: '问题说明', evidence: [cite(type === 'followup' ? answer : sources.find(source => source.kind === 'job'))] } });
  }
  if (task === 'interview.report') return envelope({ criteria: input.rubric.map(row => ({ id: row.id, rating: 3, reason: '用户回答提供了依据', evidence: [cite(sources[0])] })),
    summary: '本次回答能够描述具体工作。', strengths: ['说明自己的调研过程'], improvements: ['补充核对步骤'], nextSteps: ['再练习一个具体案例'] });
  throw new Error(`Unexpected task: ${task}`);
}

function fixture(t, generate = responder) {
  fs.mkdirSync(testRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(testRoot, 'case-'));
  const service = createCareerService({ directory, generate });
  t.after(async () => {
    await service.close();
    // Only remove the exact test-owned directory underneath the project test root.
    assert.equal(path.dirname(directory), path.resolve(testRoot));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, service, dispatch: service.dispatch };
}
async function prepared(dispatch) {
  const personal = await dispatch('material.add', { title: '产品简历', kind: 'resume', text: RESUME });
  const job = await dispatch('material.add', { title: '岗位要求', kind: 'job', text: JOB });
  const goal = await dispatch('goal.create', { title: '产品经理', company: '合成公司' });
  await dispatch('material.confirm', { versionId: personal.latestVersionId });
  await dispatch('material.confirm', { versionId: job.latestVersionId });
  await dispatch('goal.linkMaterial', { goalId: goal.id, versionId: personal.latestVersionId });
  await dispatch('goal.linkMaterial', { goalId: goal.id, versionId: job.latestVersionId });
  return { personal, job, goal, versionId: personal.latestVersionId };
}
async function startInterview(dispatch, input, options) {
  await dispatch('conversation.link', { goalId: input.goalId, sessionId: input.sessionId, versionId: input.versionId, kind: 'interview' });
  return dispatch('interview.start', input, options);
}

test('SQLite materials keep confirmed old versions and cross-goal resume reuse after reopen', async t => {
  const { directory, service, dispatch } = fixture(t);
  const { personal, goal, versionId } = await prepared(dispatch);
  const other = await dispatch('goal.create', { title: '研究助理' });
  await dispatch('goal.linkMaterial', { goalId: other.id, versionId });
  const changed = await dispatch('material.update', { materialId: personal.id, text: `${RESUME}\n补充用户自己确认的经历。` });
  assert.equal(changed.versions[0].revision, 2);
  assert.equal(changed.versions[0].confirmed, false);
  assert.equal(changed.versions[1].text, RESUME);
  assert.equal(changed.versions[1].confirmed, true);
  assert.equal((await dispatch('state')).goals.find(row => row.id === goal.id).materialLinks.find(row => row.kind === 'resume').versionId, versionId);
  await service.close();
  const reopened = createCareerService({ directory, generate: responder });
  try {
    const state = await reopened.dispatch('state');
    assert.equal(state.materials.find(row => row.id === personal.id).versions.length, 2);
    assert.equal(state.goals.find(row => row.id === other.id).materialLinks[0].versionId, versionId);
  } finally { await reopened.close(); }
  const db = new DatabaseSync(path.join(directory, 'career.sqlite'));
  try {
    db.exec('PRAGMA foreign_keys=ON');
    assert.throws(() => db.prepare('UPDATE versions SET text=? WHERE id=?').run('tampered', versionId), /immutable_version/u);
    assert.throws(() => db.prepare('INSERT INTO confirmations VALUES(?,?)').run('missing', 'now'), /FOREIGN KEY/u);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 3);
  } finally { db.close(); }
});

test('unconfirmed material and missing job evidence refuse model calls', async t => {
  let calls = 0;
  const { dispatch } = fixture(t, args => { calls++; return responder(args); });
  const personal = await dispatch('material.add', { title: '简历', kind: 'resume', text: RESUME });
  const goal = await dispatch('goal.create', { title: '产品经理', description: JOB });
  await assert.rejects(dispatch('assessment.run', { versionId: personal.latestVersionId }), { code: 'MATERIAL_NOT_CONFIRMED' });
  await assert.rejects(dispatch('goal.linkMaterial', { goalId: goal.id, versionId: personal.latestVersionId }), { code: 'MATERIAL_NOT_CONFIRMED' });
  await dispatch('material.confirm', { versionId: personal.latestVersionId });
  await assert.rejects(dispatch('assessment.run', { kind: 'fit', versionId: personal.latestVersionId, goalId: goal.id }), { code: 'JOB_MATERIAL_REQUIRED' });
  assert.equal(calls, 0);
});

test('program computes weighted scores, freezes source versions and records model provenance', async t => {
  const { dispatch } = fixture(t);
  const { personal, versionId, goal } = await prepared(dispatch);
  const result = await dispatch('assessment.run', { kind: 'fit', versionId, goalId: goal.id });
  assert.equal(result.total, 75);
  assert.equal(result.criteria.reduce((sum, row) => sum + row.weight, 0), 100);
  await dispatch('material.update', { materialId: personal.id, text: '更新后的简历正文。' });
  const state = await dispatch('state');
  assert.equal(state.assessments[0].versionId, versionId);
  assert.equal(state.assessments[0].inputVersions.find(row => row.id === versionId).hash, personal.versions[0].hash);
  assert.equal(state.runs[0].status, 'completed');
  assert.equal(state.runs[0].provider, 'fixture');
  assert.match(state.runs[0].inputHash, /^[a-f0-9]{64}$/u);
  assert.equal(state.runs[0].rubricVersion, 'zhijing-rubric-1');
});

test('missing evidence yields no total and invented citations produce a failed run without an assessment', async t => {
  let invalid = false;
  const { dispatch } = fixture(t, args => {
    const response = responder(args);
    if (invalid) response.result.criteria[0].evidence[0].quote = '不存在的原文';
    else { response.result.criteria[0].rating = null; response.result.criteria[0].evidence = []; }
    return response;
  });
  const { versionId } = await prepared(dispatch);
  const first = await dispatch('assessment.run', { versionId });
  assert.equal(first.total, null);
  invalid = true;
  await assert.rejects(dispatch('assessment.run', { versionId }), { code: 'EVIDENCE_QUOTE_MISMATCH' });
  const state = await dispatch('state');
  assert.equal(state.assessments.length, 1);
  assert.equal(state.runs.filter(row => row.status === 'failed').length, 1);
});

test('fit scores cannot use only resume evidence and absent model metadata is rejected', async t => {
  let missingMeta = false;
  const { dispatch } = fixture(t, args => {
    const response = responder(args);
    if (missingMeta) return response.result;
    for (const row of response.result.criteria) row.evidence = [cite(args.input.snapshots[0])];
    return response;
  });
  const { versionId, goal } = await prepared(dispatch);
  await assert.rejects(dispatch('assessment.run', { kind: 'fit', versionId, goalId: goal.id }), { code: 'FIT_EVIDENCE_INCOMPLETE' });
  missingMeta = true;
  await assert.rejects(dispatch('assessment.run', { versionId }), { code: 'MODEL_IDENTITY_REQUIRED' });
  assert.equal((await dispatch('state')).assessments.length, 0);
});

test('complete rewrite preview, selective acceptance, idempotency and independent versions', async t => {
  const { dispatch } = fixture(t);
  const { versionId, personal } = await prepared(dispatch);
  const proposal = await dispatch('rewrite.run', { versionId });
  assert.equal(proposal.fullText, '访谈20名用户，完成产品调研。\n编写并整理需求文档。');
  assert.equal(proposal.items.length, 2);
  const accepted = await dispatch('rewrite.accept', { rewriteId: proposal.id, itemIds: [proposal.items[0].id] });
  assert.equal(accepted.version.text, '访谈20名用户，完成产品调研。\n整理需求文档。');
  assert.equal(accepted.version.confirmed, false);
  const repeated = await dispatch('rewrite.accept', { rewriteId: proposal.id, itemIds: [proposal.items[0].id] });
  assert.equal(repeated.version.id, accepted.version.id);
  assert.equal(repeated.reused, true);
  const all = await dispatch('rewrite.accept', { rewriteId: proposal.id });
  assert.equal(all.version.text, proposal.fullText);
  const state = await dispatch('state');
  assert.equal(state.materials.find(row => row.id === personal.id).versions.length, 3);
  assert.equal(state.materials.find(row => row.id === personal.id).versions.find(row => row.id === versionId).text, RESUME);
  assert.equal(state.runs.filter(row => row.task === 'rewrite.verify' && row.status === 'completed').length, 1);
});

test('rewrite refuses fabricated numbers and fails closed on unsupported factual changes', async t => {
  let newNumber = true;
  const { dispatch } = fixture(t, args => {
    const response = responder(args);
    if (newNumber && args.task === 'rewrite.run') response.result.items[0].after = '访谈200名用户。';
    if (!newNumber && args.task === 'rewrite.verify') response.result.items[0].supported = false;
    return response;
  });
  const { versionId } = await prepared(dispatch);
  await assert.rejects(dispatch('rewrite.run', { versionId }), { code: 'REWRITE_NEW_NUMBER' });
  newNumber = false;
  await assert.rejects(dispatch('rewrite.run', { versionId }), { code: 'REWRITE_UNSUPPORTED_FACT' });
  assert.equal((await dispatch('state')).rewrites.length, 0);
});

test('general DSH sessions bind once to a goal and cannot move to a different goal', async t => {
  const { dispatch } = fixture(t);
  const first = await dispatch('goal.create', { title: '岗位一' });
  const second = await dispatch('goal.create', { title: '岗位二' });
  await dispatch('conversation.link', { sessionId: 'host-session', kind: 'chat' });
  assert.equal((await dispatch('state')).conversations[0].goalId, null);
  await dispatch('conversation.link', { sessionId: 'host-session', goalId: first.id, kind: 'chat' });
  await assert.rejects(dispatch('conversation.link', { sessionId: 'host-session', goalId: second.id }), { code: 'CONVERSATION_GOAL_IMMUTABLE' });
  assert.equal((await dispatch('state')).goals.find(row => row.id === first.id).conversations.length, 1);
});

test('text interview runs main questions and bounded followups, then produces an answer-evidence report', async t => {
  const { dispatch } = fixture(t);
  const { versionId, goal } = await prepared(dispatch);
  let value = await startInterview(dispatch, { goalId: goal.id, versionId, sessionId: 'interview-session', questionCount: 2 });
  for (const response of ['我先列调研提纲，再逐一访谈用户。', '我将记录交给用户核对。', '我按用户问题整理需求文档。', '我用访谈记录核对每条需求。']) {
    value = await dispatch('interview.answer', { interviewId: value.id, questionId: value.currentQuestionId, text: response });
  }
  assert.equal(value.status, 'completed');
  assert.equal(value.questions.filter(row => row.kind === 'main').length, 2);
  assert.equal(value.questions.filter(row => row.kind === 'followup').length, 2);
  assert.equal(value.currentQuestionId, null);
  const report = await dispatch('report.get', { interviewId: value.id });
  assert.equal(report.total, 75);
  assert.equal(report.inputAnswers.length, 4);
  const answerIds = new Set(value.questions.map(row => row.answer.id));
  assert.ok(report.criteria.every(row => row.evidence.every(ref => answerIds.has(ref.sourceId))));
  await assert.rejects(dispatch('interview.answer', { interviewId: value.id, text: '再回答' }), { code: 'INTERVIEW_COMPLETED' });
  assert.equal((await dispatch('interview.finish', { interviewId: value.id })).reportId, report.id);
});

test('failed followup preserves raw answer and resume continues without saving it twice', async t => {
  let rejectAnswer = true;
  const { dispatch } = fixture(t, args => {
    if (args.task === 'interview.answer' && rejectAnswer) throw Object.assign(new Error('synthetic provider failure'), { code: 'PROVIDER_FAILED' });
    return responder(args);
  });
  const { versionId, goal } = await prepared(dispatch);
  const started = await startInterview(dispatch, { goalId: goal.id, versionId, sessionId: 'retry-session', questionCount: 1 });
  await assert.rejects(dispatch('interview.answer', { interviewId: started.id, text: '这是我的原始回答。' }), { code: 'PROVIDER_FAILED' });
  let stored = (await dispatch('state')).interviews[0];
  assert.equal(stored.status, 'paused');
  assert.equal(stored.questions[0].answer.text, '这是我的原始回答。');
  const answerId = stored.questions[0].answer.id;
  rejectAnswer = false;
  stored = await dispatch('interview.resume', { interviewId: started.id });
  assert.equal(stored.status, 'active');
  assert.equal(stored.questions[0].answer.id, answerId);
  assert.equal(stored.questions.length, 2);
});

test('pause cancels in-flight generation and restart does not dispatch a model request', async t => {
  let startedResolve;
  const generationStarted = new Promise(resolve => { startedResolve = resolve; });
  const { directory, service, dispatch } = fixture(t, args => {
    if (args.task === 'interview.answer') { startedResolve(); return new Promise(() => {}); }
    return responder(args);
  });
  const { versionId, goal } = await prepared(dispatch);
  const started = await startInterview(dispatch, { goalId: goal.id, versionId, sessionId: 'cancel-session' });
  const answer = dispatch('interview.answer', { interviewId: started.id, text: '保留这份原始回答。' });
  const rejection = assert.rejects(answer, { code: 'CANCELLED' });
  await generationStarted;
  await dispatch('interview.pause', { interviewId: started.id });
  await rejection;
  assert.equal((await dispatch('state')).interviews[0].status, 'paused');
  await service.close();
  let calls = 0;
  const reopened = createCareerService({ directory, generate: args => { calls++; return responder(args); } });
  try {
    const state = await reopened.dispatch('state');
    assert.equal(calls, 0);
    assert.equal(state.interviews[0].questions[0].answer.text, '保留这份原始回答。');
    assert.equal(state.runs.filter(row => row.status === 'cancelled').length, 1);
  } finally { await reopened.close(); }
});

test('failed report cannot cite generated questions and can be retried from the saved answers', async t => {
  let invalidReport = true;
  const { dispatch } = fixture(t, args => {
    const response = responder(args);
    if (args.task === 'interview.report' && invalidReport) response.result.criteria[0].evidence = [{ sourceId: args.input.questions[0].id, quote: args.input.questions[0].text }];
    return response;
  });
  const { versionId, goal } = await prepared(dispatch);
  const started = await startInterview(dispatch, { goalId: goal.id, versionId, sessionId: 'report-session' });
  await dispatch('interview.answer', { interviewId: started.id, text: '我先访谈用户再写需求文档。' });
  await assert.rejects(dispatch('interview.finish', { interviewId: started.id }), { code: 'EVIDENCE_SOURCE_INVALID' });
  assert.equal((await dispatch('state')).reports.length, 0);
  invalidReport = false;
  const finished = await dispatch('interview.finish', { interviewId: started.id });
  assert.equal(finished.status, 'completed');
  assert.equal((await dispatch('state')).reports.length, 1);
});

test('source quote offsets preserve Chinese and emoji UTF-16 boundaries', async t => {
  const { dispatch } = fixture(t, args => envelope({ criteria: args.input.rubric.map(row => ({ id: row.id, rating: 3, reason: '使用完整字符',
    evidence: [{ sourceId: args.input.snapshots[0].id, quote: '😀', start: 1, end: 2 }] })), suggestions: [], missing: [] }));
  const personal = await dispatch('material.add', { title: '中文简历', kind: 'resume', text: '甲😀乙' });
  await dispatch('material.confirm', { versionId: personal.latestVersionId });
  await assert.rejects(dispatch('assessment.run', { versionId: personal.latestVersionId }), { code: 'EVIDENCE_QUOTE_MISMATCH' });
});

test('exclusive owner prevents a second service from recovering another live service runs', async t => {
  const { directory, dispatch } = fixture(t);
  assert.throws(() => createCareerService({ directory, generate: responder }), { code: 'STORAGE_BUSY' });
  assert.equal((await dispatch('state')).runs.length, 0);
});

test('service shutdown cancels an uncooperative generator, saves no fake result, and can reopen', async t => {
  let start;
  const began = new Promise(resolve => { start = resolve; });
  const { directory, service, dispatch } = fixture(t, () => { start(); return new Promise(() => {}); });
  const { versionId } = await prepared(dispatch);
  const scoring = dispatch('assessment.run', { versionId });
  const rejected = assert.rejects(scoring, { code: 'CANCELLED' });
  await began;
  await service.close();
  await rejected;
  const reopened = createCareerService({ directory, generate: responder });
  try {
    const state = await reopened.dispatch('state');
    assert.equal(state.assessments.length, 0);
    assert.equal(state.runs[0].status, 'cancelled');
  } finally { await reopened.close(); }
});

test('provider error body is not exposed and supplied failure model identity is retained', async t => {
  const { dispatch } = fixture(t, () => { throw Object.assign(new Error('secret request body and key never exposed'),
    { code: 'PROVIDER_FAILED', model: { provider: 'fixture', model: 'failed-model' } }); });
  const { versionId } = await prepared(dispatch);
  await assert.rejects(dispatch('assessment.run', { versionId }), error => error.code === 'PROVIDER_FAILED' && error.message === 'PROVIDER_FAILED');
  const state = await dispatch('state');
  assert.equal(state.runs[0].model, 'failed-model');
  assert.equal(state.runs[0].status, 'failed');
});

test('a conversation freezes confirmed material versions and goal metadata before later updates', async t => {
  const { dispatch } = fixture(t);
  const { personal, versionId, goal } = await prepared(dispatch);
  const linked = await dispatch('conversation.link', { goalId: goal.id, sessionId: 'fixed-context', kind: 'chat' });
  assert.ok(linked.materialVersionIds.includes(versionId));
  assert.equal(linked.contextStatus, 'frozen');
  const updated = await dispatch('material.update', { materialId: personal.id, text: '用户新录入的独立经历。' });
  await dispatch('material.confirm', { versionId: updated.latestVersionId });
  await dispatch('goal.linkMaterial', { goalId: goal.id, versionId: updated.latestVersionId });
  await dispatch('goal.update', { goalId: goal.id, title: '改名后的岗位' });
  const context = await dispatch('conversation.context', { sessionId: 'fixed-context' });
  assert.equal(context.materials.find(row => row.kind === 'resume').id, versionId);
  assert.equal(context.materials.find(row => row.kind === 'resume').text, RESUME);
  assert.equal(context.goal.title, '产品经理');
  await assert.rejects(dispatch('conversation.context', { sessionId: 'fixed-context' }, { sessionId: 'foreign' }), { code: 'CONVERSATION_SESSION_MISMATCH' });
  await assert.rejects(dispatch('conversation.link', { goalId: goal.id, sessionId: 'fixed-context', versionId: updated.latestVersionId }), { code: 'CONVERSATION_CONTEXT_IMMUTABLE' });
});

test('general conversation binds selected confirmed resume once while attaching goal evidence', async t => {
  const { dispatch } = fixture(t);
  const { goal } = await prepared(dispatch);
  const another = await dispatch('material.add', { title: '另一个版本', kind: 'resume', text: '另一份简历的用户原话。' });
  await assert.rejects(dispatch('conversation.link', { sessionId: 'unconfirmed-chat', versionId: another.latestVersionId }), { code: 'MATERIAL_NOT_CONFIRMED' });
  await dispatch('material.confirm', { versionId: another.latestVersionId });
  await dispatch('conversation.link', { sessionId: 'general-fixed', versionId: another.latestVersionId });
  await dispatch('conversation.link', { sessionId: 'general-fixed', goalId: goal.id });
  const context = await dispatch('conversation.context', { sessionId: 'general-fixed' });
  assert.equal(context.materials.find(row => row.kind === 'resume').id, another.latestVersionId);
  assert.equal(context.materials.filter(row => row.kind === 'job').length, 1);
});

test('forward v1 migration preserves legacy conversations without inventing historical material bindings', async t => {
  fs.mkdirSync(testRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(testRoot, 'upgrade-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(directory, 'career.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);');
  db.exec(CAREER_MIGRATIONS[0].sql);
  db.prepare('INSERT INTO schema_migrations VALUES(1,?)').run('2026-11-06');
  db.prepare('INSERT INTO goals VALUES(?,?,?,?,?,?,?)').run('goal-v1', '历史岗位', '', '', 'active', 't', 't');
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?)').run('conversation-v1', 'goal-v1', 'session-v1', '历史对话', 'chat', 't');
  db.close();
  const service = createCareerService({ directory, generate: responder });
  try {
    const state = await service.dispatch('state');
    assert.equal(state.schemaVersion, 3);
    assert.equal(state.conversations[0].sessionId, 'session-v1');
    assert.equal(state.conversations[0].contextStatus, 'legacy-unbound');
    assert.deepEqual(state.conversations[0].materialVersionIds, []);
    await assert.rejects(service.dispatch('conversation.context', { sessionId: 'session-v1' }), { code: 'CONVERSATION_CONTEXT_LEGACY' });
    const linked = await service.dispatch('conversation.link', { goalId: 'goal-v1', sessionId: 'session-v2' });
    assert.equal(linked.contextStatus, 'frozen');
  } finally { await service.close(); }
});

test('failed v2 migration rolls back ALTER operations and releases its startup owner', t => {
  fs.mkdirSync(testRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(testRoot, 'rollback-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let db = new DatabaseSync(path.join(directory, 'career.sqlite'));
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);');
  db.exec(CAREER_MIGRATIONS[0].sql);
  db.exec("INSERT INTO schema_migrations VALUES(1,'old'); CREATE TABLE conversation_materials(existing TEXT);");
  db.close();
  assert.throws(() => createCareerService({ directory, generate: responder }), /already exists/u);
  assert.equal(fs.existsSync(path.join(directory, 'career.sqlite.owner')), false);
  db = new DatabaseSync(path.join(directory, 'career.sqlite'));
  try {
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 1);
    assert.equal(db.prepare('PRAGMA table_info(conversations)').all().some(row => row.name === 'context_state'), false);
    assert.equal(db.prepare('PRAGMA table_info(conversation_materials)').all()[0].name, 'existing');
  } finally { db.close(); }
});

test('scoped assessment, rewrite and interview use frozen evidence after goal materials change', async t => {
  const observed = [];
  const { dispatch } = fixture(t, args => { observed.push(structuredClone({ task: args.task, input: args.input })); return responder(args); });
  const { goal, job, versionId } = await prepared(dispatch);
  await dispatch('conversation.link', { goalId: goal.id, sessionId: 'frozen-chat', kind: 'chat' });
  await dispatch('conversation.link', { goalId: goal.id, sessionId: 'frozen-interview', kind: 'interview' });
  const newJob = await dispatch('material.update', { materialId: job.id, text: '新岗位要求完全不同的机器学习经历。' });
  await dispatch('material.confirm', { versionId: newJob.latestVersionId });
  await dispatch('goal.linkMaterial', { goalId: goal.id, versionId: newJob.latestVersionId });
  await dispatch('goal.update', { goalId: goal.id, title: '已经改名的岗位', company: '新的合成公司' });
  const assessment = await dispatch('assessment.run', { kind: 'fit', versionId, goalId: goal.id }, { sessionId: 'frozen-chat' });
  await dispatch('rewrite.run', { versionId, goalId: goal.id, sessionId: 'frozen-chat' });
  const started = await dispatch('interview.start', { goalId: goal.id, versionId, sessionId: 'frozen-interview' });
  await dispatch('interview.answer', { interviewId: started.id, text: '我先记录访谈问题再整理回答。' });
  await dispatch('interview.finish', { interviewId: started.id });
  assert.ok(assessment.inputVersions.some(row => row.id === job.latestVersionId));
  assert.ok(!assessment.inputVersions.some(row => row.id === newJob.latestVersionId));
  for (const task of ['assessment.run', 'rewrite.run', 'interview.start']) {
    const call = observed.find(row => row.task === task);
    assert.equal(call.input.snapshots.find(row => row.kind === 'job').id, job.latestVersionId);
    assert.equal(call.input.snapshots.find(row => row.kind === 'job').text, JOB);
  }
  assert.equal(started.goalSnapshot.title, '产品经理');
  assert.equal(observed.find(row => row.task === 'interview.report').input.goal.title, '产品经理');
  assert.equal(observed.find(row => row.task === 'interview.report').input.goal.company, '合成公司');
});

test('scoped model actions reject cross-session ids, goals, versions and unlinked sessions before calling a model', async t => {
  let calls = 0;
  const { dispatch } = fixture(t, args => { calls++; return responder(args); });
  const { goal, versionId } = await prepared(dispatch);
  const anotherGoal = await dispatch('goal.create', { title: '另一岗位' });
  const anotherResume = await dispatch('material.add', { title: '另一简历', kind: 'resume', text: '独立经历。' });
  await dispatch('material.confirm', { versionId: anotherResume.latestVersionId });
  await dispatch('conversation.link', { goalId: goal.id, sessionId: 'allowed-chat', kind: 'chat' });
  await dispatch('conversation.link', { goalId: goal.id, sessionId: 'allowed-interview', kind: 'interview' });
  for (const action of ['assessment.run', 'rewrite.run', 'interview.start']) {
    await assert.rejects(dispatch(action, { goalId: goal.id, versionId, sessionId: 'foreign' }, { sessionId: 'allowed-chat' }), { code: 'CONVERSATION_SESSION_MISMATCH' });
    await assert.rejects(dispatch(action, { goalId: anotherGoal.id, versionId, sessionId: 'allowed-interview' }), { code: 'CONVERSATION_CONTEXT_MISMATCH' });
    await assert.rejects(dispatch(action, { goalId: goal.id, versionId: anotherResume.latestVersionId, sessionId: 'allowed-interview' }), { code: 'CONVERSATION_CONTEXT_MISMATCH' });
    await assert.rejects(dispatch(action, { goalId: goal.id, versionId, sessionId: 'unlinked' }), { code: 'CONVERSATION_NOT_FOUND' });
  }
  assert.equal(calls, 0);
});

test('interview answers and evidence retain the exact native user message including CRLF', async t => {
  const { dispatch } = fixture(t);
  const { goal, versionId } = await prepared(dispatch);
  const started = await startInterview(dispatch, { goalId: goal.id, versionId, sessionId: 'raw-message', questionCount: 1 });
  const raw = '我先写提纲。\r\n再访谈用户。\r保留原始换行。';
  const result = await dispatch('interview.answer', { interviewId: started.id, text: raw });
  assert.equal(result.questions[0].answer.text, raw);
  assert.equal(result.questions[0].evaluation.evidence[0].quote, raw);
  assert.equal(result.questions[0].evaluation.evidence[0].end, raw.length);
});

test('speech provenance persists exact ASR, review history and final answer without submitting draft text to the model', async t => {
  const calls = [];
  const { directory, service, dispatch } = fixture(t, args => { calls.push(structuredClone(args.input)); return responder(args); });
  const { goal, versionId } = await prepared(dispatch);
  const started = await startInterview(dispatch, { goalId: goal.id, versionId, sessionId: 'speech-provenance', questionCount: 1 });
  const target = { interviewId: started.id, questionId: started.currentQuestionId };
  const raw = '我访坛用户。\r\n保存记录。';
  const draft = await dispatch('interview.voiceTranscript', { ...target, transcript: raw, providerId: 'fixture-asr', audioSeconds: 3.75 });
  const first = await dispatch('interview.voiceReview', { ...target, speechDraftId: draft.speechDraftId, editedTranscript: '我访谈用户。\r\n保存记录。', finalText: '我访谈用户并保存记录。' });
  const identical = await dispatch('interview.voiceReview', { ...target, speechDraftId: draft.speechDraftId, editedTranscript: '我访谈用户。\r\n保存记录。', finalText: '我访谈用户并保存记录。' });
  assert.equal(first.speechReviewId, identical.speechReviewId);
  const finalText = '我先访谈用户。\r\n然后保存记录。';
  const revised = await dispatch('interview.voiceReview', { ...target, speechDraftId: draft.speechDraftId, editedTranscript: '我访谈用户并保存记录。', finalText });
  assert.notEqual(revised.speechReviewId, first.speechReviewId);
  assert.equal(calls.length, 1, 'ASR and review storage must not start model work');
  const result = await dispatch('interview.answer', { ...target, text: finalText });
  const answered = result.questions[0];
  assert.equal(answered.answer.speechDraftId, draft.speechDraftId);
  assert.equal(answered.answer.speechReviewId, revised.speechReviewId);
  assert.equal(answered.answer.text, finalText);
  assert.equal(answered.speechDrafts[0].rawTranscript, raw);
  assert.equal(answered.speechDrafts[0].reviews.length, 2);
  assert.equal(calls[1].currentQuestion.speechDrafts, undefined);
  assert.equal(calls[1].questions[0].speechDrafts, undefined);
  assert.equal(calls[1].snapshots.find(row => row.kind === 'answer').text, finalText);
  await service.close();
  const reopened = createCareerService({ directory, generate: responder });
  try {
    const persisted = (await reopened.dispatch('state')).interviews[0].questions[0];
    assert.equal(persisted.speechDrafts[0].rawTranscript, raw);
    assert.equal(persisted.speechDrafts[0].providerId, 'fixture-asr');
    assert.equal(persisted.speechDrafts[0].audioSeconds, 3.75);
    assert.equal(persisted.speechDrafts[0].reviews[0].finalText, '我访谈用户并保存记录。');
    assert.equal(persisted.answer.speechReviewId, revised.speechReviewId);
  } finally { await reopened.close(); }
});

test('speech writes reject cancellation, paused or changed questions, foreign sessions and excess drafts', async t => {
  const { dispatch } = fixture(t);
  const { goal, versionId } = await prepared(dispatch);
  const started = await startInterview(dispatch, { goalId: goal.id, versionId, sessionId: 'speech-guards', questionCount: 1 });
  const target = { interviewId: started.id, questionId: started.currentQuestionId };
  const input = { ...target, transcript: '我整理过访谈记录。', providerId: 'fixture-asr', audioSeconds: 1 };
  await assert.rejects(dispatch('interview.voiceTranscript', input, { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  await assert.rejects(dispatch('interview.voiceTranscript', input, { sessionId: 'foreign' }), { code: 'INTERVIEW_SESSION_MISMATCH' });
  await assert.rejects(dispatch('interview.voiceTranscript', { ...input, questionId: 'other-question' }), { code: 'QUESTION_CHANGED' });
  await assert.rejects(dispatch('interview.voiceTranscript', { ...input, audioSeconds: -1 }), { code: 'INVALID_AUDIO_DURATION' });
  await dispatch('interview.pause', { interviewId: started.id });
  await assert.rejects(dispatch('interview.voiceTranscript', input), { code: 'INTERVIEW_PAUSED' });
  await dispatch('interview.resume', { interviewId: started.id });
  let draft;
  for (let index = 0; index < 8; index++) draft = await dispatch('interview.voiceTranscript', input);
  await assert.rejects(dispatch('interview.voiceTranscript', input), { code: 'SPEECH_DRAFT_LIMIT' });
  const review = { ...target, speechDraftId: draft.speechDraftId, editedTranscript: input.transcript, finalText: input.transcript };
  await assert.rejects(dispatch('interview.voiceReview', { ...review, speechDraftId: 'foreign-draft' }), { code: 'SPEECH_DRAFT_NOT_FOUND' });
  await dispatch('interview.voiceReview', review);
  const result = await dispatch('interview.answer', { ...target, text: '实际提交的是另一份文字回答。' });
  assert.equal(result.questions[0].answer.speechDraftId, undefined, 'A changed final answer must not claim reviewed ASR provenance');
  await assert.rejects(dispatch('interview.voiceReview', review), { code: 'QUESTION_CHANGED' });
  await assert.rejects(dispatch('interview.voiceTranscript', input), { code: 'QUESTION_CHANGED' });
  assert.equal((await dispatch('state')).interviews[0].questions[1].speechDrafts, undefined);
});

test('unreviewed speech never becomes an answer or acquires answer provenance', async t => {
  const { dispatch } = fixture(t);
  const { goal, versionId } = await prepared(dispatch);
  const started = await startInterview(dispatch, { goalId: goal.id, versionId, sessionId: 'speech-unreviewed', questionCount: 1 });
  const target = { interviewId: started.id, questionId: started.currentQuestionId };
  const transcript = '我自己记录访谈。';
  await dispatch('interview.voiceTranscript', { ...target, transcript, providerId: 'fixture-asr', audioSeconds: 1 });
  assert.equal((await dispatch('state')).interviews[0].questions[0].answer, null);
  const result = await dispatch('interview.answer', { ...target, text: transcript });
  assert.equal(result.questions[0].answer.speechDraftId, undefined);
  assert.equal(result.questions[0].speechDrafts[0].reviews.length, 0);
});

test('model selection only comes from trusted dispatch options and reaches both rewrite model tasks', async t => {
  const selections = [];
  const { dispatch } = fixture(t, args => { selections.push(args.modelSelection); return responder(args); });
  const { versionId } = await prepared(dispatch);
  const modelSelection = { provider: 'session-provider', model: 'session-model', reasoningEffort: 'high' };
  await dispatch('rewrite.run', { versionId, modelSelection: { provider: 'injected', model: 'ignored' } }, { modelSelection });
  assert.deepEqual(selections, [modelSelection, modelSelection]);
  assert.notEqual(selections[0], modelSelection);
  await dispatch('assessment.run', { versionId, modelSelection });
  assert.equal(selections[2], undefined);
});

test('pause and resume invalidate an older ASR response even for the same unanswered question', async t => {
  const { dispatch } = fixture(t);
  const { goal, versionId } = await prepared(dispatch);
  const started = await startInterview(dispatch, { goalId: goal.id, versionId, sessionId: 'speech-epoch', questionCount: 1 });
  const input = { interviewId: started.id, questionId: started.currentQuestionId, expectedVoiceEpoch: started.voiceEpoch,
    transcript: '我先记录访谈过程。', providerId: 'fixture-asr', audioSeconds: 1 };
  assert.equal(started.voiceEpoch, 0);
  const paused = await dispatch('interview.pause', { interviewId: started.id });
  assert.equal(paused.voiceEpoch, 1);
  const resumed = await dispatch('interview.resume', { interviewId: started.id });
  assert.equal(resumed.currentQuestionId, input.questionId);
  await assert.rejects(dispatch('interview.voiceTranscript', input), { code: 'VOICE_QUESTION_CHANGED' });
  assert.equal((await dispatch('state')).interviews[0].questions[0].speechDrafts, undefined);
  const newInput = { ...input, expectedVoiceEpoch: resumed.voiceEpoch };
  await dispatch('interview.voiceTranscript', newInput);
  await dispatch('interview.voiceTranscript', newInput);
  assert.equal((await dispatch('state')).interviews[0].questions[0].speechDrafts.length, 2, 'Another ASR result must not invalidate the active question epoch');
});
