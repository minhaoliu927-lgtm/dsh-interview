import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRealtimeService } from '../src/voice/realtime-service.js';
import { createRealtimeProvider } from '../src/voice/realtime-provider.js';
import { createCareerService } from '../src/domain/index.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const config = { region: 'beijing', workspace: 'fixture-workspace', model: 'qwen3.5-omni-plus-realtime', credentialRef: 'official-ref' };
function fixture(t, options = {}) {
  const interview = { id: 'interview-1', sessionId: 'session-1', mode: 'realtime', status: 'paused', language: 'zh', questionCount: 3,
    goalSnapshot: { title: '软件工程师' }, snapshots: [{ id: 'version-1', title: '简历', kind: 'resume', text: '已确认简历原文', hash: 'frozen-hash' }], currentQuestionId: null };
  const rows = [], begins = [], ends = [], marks = [], dispatches = [], events = [], providers = [], recorders = [];
  const career = { dispatch(action) { dispatches.push(action); assert.equal(action, 'state', 'Realtime must not invoke a text Agent task'); return { interviews: [interview] }; },
    realtime: {
      begin(input) { begins.push(input); const epoch = begins.length; interview.status = 'active'; return { callId: `call-${epoch}`, epoch, interview: structuredClone(interview) }; },
      entries() { return rows; }, pending() { return rows.filter(row => !marks.includes(row.id)); }, markMirrored(id) { marks.push(id); },
      record(input) {
        assert.equal(interview.status, 'active');
        const prior = rows.find(row => row.callId === input.callId && row.key === input.key); if (prior) return prior;
        const value = { ...input, id: `event-${rows.length + 1}`, provider: 'qwen-realtime', model: config.model, createdAt: '2026-11-12T00:00:00.000Z' };
        if (value.role === 'assistant') { value.questionId = value.id; interview.currentQuestionId = value.id; }
        rows.push(value); return value;
      },
      end(input) { ends.push(input); interview.status = 'paused'; return interview; },
    } };
  const providerFactory = deps => {
    const p = { deps, connections: [], audio: [], interrupts: 0, closes: 0, requested: 0,
      async connect(input) { p.connections.push(input); assert.equal(await deps.resolveCredential(config.credentialRef), 'fixture-secret');
        p.emit({ type: 'ready', inputSampleRate: 16000, outputSampleRate: 24000 }); },
      emit(event) { const current = p.connections[0]; deps.onEvent({ sessionId: current.sessionId, epoch: current.epoch, turnId: 0, ...event }); },
      requestResponse() { p.requested++; }, appendAudio(input) { p.audio.push(input); return true; },
      cancelResponse() { p.interrupts++; p.emit({ type: 'interrupted', responseId: 'response-1', reason: 'user' }); },
      close() { p.closes++; if (p.connections.length) p.emit({ type: 'closed' }); }, getState() { return { phase: 'ready', turnId: 1 }; },
    }; providers.push(p); return p;
  };
  const createRecorder = deps => {
    const recorder = { deps, opens: 0, records: [], closes: 0,
      async open() { recorder.opens++; }, async recordTurn(id) { recorder.records.push(id); }, async close() { recorder.closes++; } };
    recorders.push(recorder); return recorder;
  };
  const service = createRealtimeService({ career, getConfig: () => config, resolveCredential: async () => 'fixture-secret', providerFactory, createRecorder, ...options });
  t.after(() => service.close());
  const start = (input = {}, extras = {}) => service.open({ interviewId: interview.id, ownerId: 'page-1', ...input }, { onEvent: event => events.push(event), ...extras });
  const running = async (input = {}, extras = {}) => {
    const pending = start(input, extras);
    // Observe failures immediately even while waiting for the synthetic ready event.
    pending.catch(() => {});
    for (let i = 0; i < 40 && !providers.at(-1)?.requested; i++) await tick();
    assert.equal(providers.at(-1)?.requested, 1, 'provider must be ready before greeting');
    await tick();
    return { pending, provider: providers.at(-1), callId: `call-${begins.length}` };
  };
  return { service, career, interview, rows, begins, ends, marks, dispatches, events, providers, recorders, start, running };
}
const emitQuestion = (provider, text = '第一题', itemId = 'assistant-1') => provider.emit({ type: 'output-transcript', responseId: itemId, itemId, text });
const emitStart = (provider, itemId = 'user-1') => {
  provider.emit({ type: 'speech-started', itemId }); provider.emit({ type: 'input-committed', itemId });
};

test('Host preflights official credentials, freezes instructions, awaits recorder and streams call identity without a second model', async t => {
  const f = fixture(t), run = await f.running();
  assert.equal(f.events[0].type, 'call'); assert.equal(f.events[0].callId, 'call-1'); assert.equal(f.events[0].sessionId, 'session-1');
  assert.equal(f.events[1].type, 'ready'); assert.deepEqual(run.provider.deps.tools, []);
  assert.equal(run.provider.connections[0].instructions.includes('已确认简历原文'), true);
  assert.equal(run.provider.connections[0].instructions.includes('No external tools'), true);
  assert.equal(JSON.stringify(f.events).includes('fixture-secret'), false);
  assert.equal(f.recorders[0].opens, 1); assert.equal(f.recorders[0].deps.interview.id, 'interview-1');
  const result = await f.service.control({ callId: run.callId, ownerId: 'page-1', action: 'end' });
  assert.equal(result.reason, 'ENDED'); await run.pending;
  assert.equal(f.ends[0].reason, 'ENDED'); assert.equal(run.provider.closes, 1); assert.equal(f.recorders[0].closes, 1);
  assert.deepEqual(f.dispatches, ['state']);
});

test('missing credentials, wrong mode, context overload and missing recorder never open a provider connection', async t => {
  const missing = fixture(t, { resolveCredential: async () => null });
  await assert.rejects(missing.start(), { code: 'credential-unavailable' }); assert.equal(missing.begins.length, 0); assert.equal(missing.providers.length, 0);
  const mode = fixture(t); mode.interview.mode = 'text'; await assert.rejects(mode.start(), { code: 'realtime-interview-required' });
  assert.equal(mode.providers.length, 0);
  const large = fixture(t); large.interview.snapshots[0].text = 'x'.repeat(32_000);
  await assert.rejects(large.start(), { code: 'realtime-context-limit' }); assert.equal(large.providers.length, 0); assert.equal(large.begins.length, 0);
  const absent = fixture(t, { createRecorder: undefined }); await assert.rejects(absent.start(), { code: 'realtime-recorder-required' }); assert.equal(absent.providers.length, 0);
});

test('one owner and one interview are reserved before asynchronous setup; foreign controls fail before touching transport', async t => {
  const f = fixture(t), run = await f.running();
  await assert.rejects(f.start({ ownerId: 'another-page' }), { code: 'realtime-in-use' });
  await assert.rejects(f.start({ interviewId: 'other' }), { code: 'realtime-in-use' });
  await assert.rejects(f.service.control({ callId: run.callId, ownerId: 'another-page', action: 'end' }), { code: 'realtime-call-forbidden' });
  assert.equal(run.provider.closes, 0);
  await assert.rejects(f.start({ apiKey: 'client-secret' }), { code: 'invalid-realtime-call' });
  await f.service.control({ callId: run.callId, ownerId: 'page-1', action: 'pause' }); await run.pending;
});

test('speech onset freezes question binding across late transcriptions; commit without onset stays unassigned', async t => {
  const f = fixture(t), run = await f.running(), p = run.provider;
  emitQuestion(p, '第一题', 'q1'); emitStart(p, 'u1');
  emitQuestion(p, '第二题', 'q2'); emitStart(p, 'u2');
  p.emit({ type: 'input-transcript', itemId: 'u1', text: '  第一轮真实转写\r\n原样保留  ' });
  p.emit({ type: 'input-transcript', itemId: 'u2', text: '第二轮回答' });
  p.emit({ type: 'input-committed', itemId: 'orphan' });
  p.emit({ type: 'input-transcript', itemId: 'orphan', text: '没有观察到起点' });
  p.emit({ type: 'input-transcript-delta', itemId: 'draft', text: '尚未完成', stash: '语音' });
  await tick(); await f.service.control({ callId: run.callId, ownerId: 'page-1', action: 'pause' }); await run.pending;
  const [first, second] = f.rows.filter(row => row.role === 'assistant');
  const users = f.rows.filter(row => row.role === 'user');
  assert.equal(users.length, 3); assert.equal(users[0].questionId, first.questionId); assert.equal(users[1].questionId, second.questionId);
  assert.equal(users[2].questionId, null); assert.equal(users[0].text, '  第一轮真实转写\r\n原样保留  ');
  assert.equal(f.rows.some(row => row.text.includes('尚未完成')), false);
  assert.equal(f.rows.length, f.marks.length);
  const ledger = f.recorders[0].deps.readLedger(); assert.equal(ledger.sessionId, 'session-1');
  assert.equal(ledger.entries[0].createdAt, Date.parse('2026-11-12T00:00:00.000Z'));
  assert.equal(ledger.entries[0].eventKey, 'assistant:q1');
});

test('observed partial interviewer text is sealed as interrupted once and never replaced by a late full transcript', async t => {
  const f = fixture(t), run = await f.running(), p = run.provider;
  p.emit({ type: 'output-transcript-delta', responseId: 'r1', itemId: 'q1', delta: '请介绍' });
  p.emit({ type: 'output-transcript-delta', responseId: 'r1', itemId: 'q1', delta: '你的项目' });
  p.emit({ type: 'interrupted', responseId: 'r1' }); emitStart(p, 'u1');
  p.emit({ type: 'output-transcript', responseId: 'r1', itemId: 'q1', text: '迟到的完整问题不覆盖已发生的打断' });
  p.emit({ type: 'input-transcript', itemId: 'u1', text: '真实回答' });
  await tick(); await f.service.control({ callId: run.callId, ownerId: 'page-1', action: 'end' }); await run.pending;
  assert.equal(f.rows.length, 2); assert.equal(f.rows[0].text, '请介绍你的项目'); assert.equal(f.rows[0].interrupted, true);
  assert.equal(f.rows[0].playedMs, null, 'received subtitle does not prove audible playback');
  assert.equal(f.rows[1].questionId, f.rows[0].questionId);
});

test('duplicate provider finals and foreign session/epoch events cannot create or replace ledger records', async t => {
  const f = fixture(t), run = await f.running(), p = run.provider;
  p.emit({ type: 'output-transcript', itemId: 'foreign', text: 'foreign', epoch: 99 });
  p.emit({ type: 'output-transcript', itemId: 'foreign', text: 'foreign', sessionId: 'other' });
  emitQuestion(p); emitQuestion(p); emitStart(p);
  p.emit({ type: 'input-transcript', itemId: 'user-1', text: '回答' });
  p.emit({ type: 'input-transcript', itemId: 'user-1', text: '改写后的迟到重复' });
  await tick(); await f.service.control({ callId: run.callId, ownerId: 'page-1', action: 'end' }); await run.pending;
  assert.deepEqual(f.rows.map(row => row.text), ['第一题', '回答']);
});

test('pause drains already received final answers and observed partial output before ending the ledger', async t => {
  const gate = deferred(); let block = false;
  const f = fixture(t), run = await f.running({}, { onEvent: async event => { if (event.type === 'audio' && block) await gate.promise; } }), p = run.provider;
  emitQuestion(p); emitStart(p); await tick(); block = true;
  p.emit({ type: 'audio', audioBase64: 'AAA=' });
  p.emit({ type: 'input-transcript', itemId: 'user-1', text: '已到达但待处理的回答' });
  p.emit({ type: 'output-transcript-delta', itemId: 'q2', responseId: 'r2', delta: '尚未说完' });
  await tick(); await f.service.control({ callId: run.callId, ownerId: 'page-1', action: 'pause' }); await run.pending;
  assert.equal(f.rows.find(row => row.role === 'user').text, '已到达但待处理的回答');
  assert.equal(f.rows.at(-1).text, '尚未说完'); assert.equal(f.rows.at(-1).interrupted, true);
  gate.resolve();
});

test('stream delivery failures close resources and pause; raw errors never escape into lifecycle events', async t => {
  const f = fixture(t); const run = await f.running({}, { onEvent: event => { if (event.type === 'audio') throw new Error('private transport key/path'); f.events.push(event); } });
  run.provider.emit({ type: 'audio', audioBase64: 'AAA=' });
  const result = await run.pending;
  assert.equal(result.status, 'paused'); assert.equal(run.provider.closes, 1); assert.equal(f.recorders[0].closes, 1);
  assert.equal(JSON.stringify(f.events).includes('private transport'), false); assert.equal(f.ends.length, 1);
});

test('slow outgoing audio has a bounded queue and stops the supplier rather than growing an unbounded recording', async t => {
  const f = fixture(t), run = await f.running({}, { onEvent: event => event.type === 'audio' ? new Promise(() => {}) : undefined });
  for (let i = 0; i < 140; i++) run.provider.emit({ type: 'audio', audioBase64: 'AAA=' });
  const result = await run.pending; assert.equal(result.reason, 'stream-backpressure'); assert.equal(run.provider.closes, 1);
});

test('abort during credential lookup releases owner reservation and never starts the ledger or supplier', async t => {
  const credential = deferred(), controller = new AbortController();
  const f = fixture(t, { resolveCredential: () => credential.promise });
  const pending = f.start({}, { signal: controller.signal }); await tick(); controller.abort(); await pending;
  credential.resolve('late-secret'); await tick();
  assert.equal(f.providers.length, 0); assert.equal(f.begins.length, 0);
});

test('an asynchronous recorder factory is supported; a late recorder after cancellation is closed', async t => {
  const factory = deferred(), controller = new AbortController(); let closed = 0;
  const f = fixture(t, { createRecorder: () => factory.promise });
  const pending = f.start({}, { signal: controller.signal }); await tick(); controller.abort(); await pending;
  factory.resolve({ open() { assert.fail('late recorder must not open'); }, recordTurn() {}, close() { closed++; } });
  await tick(); assert.equal(closed, 1); assert.equal(f.providers.length, 0); assert.equal(f.ends.length, 1);
});

test('provider errors pause and reconnection is explicit with frozen history and no repeated sends', async t => {
  const f = fixture(t), first = await f.running(); emitQuestion(first.provider); await tick();
  first.provider.emit({ type: 'error', code: 'network-lost', message: 'network failed' }); await first.pending;
  assert.equal(f.providers.length, 1); assert.equal(f.ends[0].reason, 'network-lost');
  const second = await f.running(); assert.equal(second.provider.connections[0].epoch, 2);
  assert.equal(second.provider.connections[0].instructions.includes('第一题'), true);
  assert.equal(second.provider.audio.length, 0);
  await f.service.control({ callId: second.callId, ownerId: 'page-1', action: 'end' }); await second.pending;
  await f.service.close(); await assert.rejects(f.start(), { code: 'realtime-service-closed' });
});

test('authenticated controls delegate bounded PCM and interruption only to the call owner', async t => {
  const f = fixture(t), run = await f.running();
  const audio = { callId: run.callId, ownerId: 'page-1', action: 'audio', seq: 0, audioBase64: 'AAA=' };
  assert.equal((await f.service.control(audio)).accepted, true);
  assert.deepEqual(run.provider.audio, [{ audioBase64: 'AAA=', seq: 0 }]);
  await f.service.control({ callId: run.callId, ownerId: 'page-1', action: 'interrupt' }); assert.equal(run.provider.interrupts, 1);
  await f.service.close(); await run.pending;
  await assert.rejects(f.service.control(audio), { code: 'realtime-call-forbidden' });
});

test('official provider events integrate with real SQLite ledger, exact original answers, pause/resume and native recorder receipts', async t => {
  const base = path.resolve(process.env.ZHIJING_TEST_ROOT ?? fileURLToPath(new URL('../.runtime/tests/realtime-service/', import.meta.url)));
  fs.mkdirSync(base, { recursive: true }); const directory = fs.mkdtempSync(path.join(base, 'case-'));
  const career = createCareerService({ directory, generate: () => assert.fail('Realtime must not call a text model') });
  let service;
  t.after(async () => { await service?.close(); await career.close(); assert.equal(path.dirname(directory), path.resolve(base)); fs.rmSync(directory, { recursive: true, force: true }); });
  const goal = await career.dispatch('goal.create', { title: '合成测试岗位' });
  let versionId;
  for (const kind of ['resume', 'job']) {
    const material = await career.dispatch('material.add', { title: kind, kind, text: kind === 'resume' ? '进行数据核对，维护测试用例。' : '岗位要求核对数据和编写测试。' });
    await career.dispatch('material.confirm', { versionId: material.latestVersionId });
    await career.dispatch('goal.linkMaterial', { goalId: goal.id, versionId: material.latestVersionId });
    if (kind === 'resume') versionId = material.latestVersionId;
  }
  await career.dispatch('conversation.link', { goalId: goal.id, versionId, sessionId: 'real-ledger-session', kind: 'interview' });
  const interview = career.realtime.create({ goalId: goal.id, versionId, sessionId: 'real-ledger-session', language: 'zh', workspaceId: 'fixture-workspace' });
  class Socket extends EventTarget {
    readyState = 1; sent = []; sequence = 0;
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
    event(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event_id: `vendor-${++this.sequence}`, ...value }) })); }
  }
  let socket, identity; const mirrored = [], observed = [];
  service = createRealtimeService({ career, getConfig: () => config, resolveCredential: async () => 'synthetic-only-key',
    providerFactory: dependencies => createRealtimeProvider({ ...dependencies, inputFinalizationTimeoutMs: 40 }),
    socketFactory: () => { socket = new Socket(); return socket; },
    createRecorder: ({ readLedger }) => ({ async open() {}, async close() {}, async recordTurn(eventId) {
      const entry = readLedger().entries.find(row => row.id === eventId); assert.ok(entry); mirrored.push(entry);
    } }),
  });
  async function start() {
    socket = null;
    const pending = service.open({ interviewId: interview.id, ownerId: 'page' }, { onEvent: event => { observed.push(event); if (event.type === 'call') identity = event; } });
    pending.catch(() => {});
    for (let i = 0; i < 40 && !socket; i++) await tick(); assert.ok(socket);
    socket.event({ type: 'session.created', session: { id: 'vendor-session' } });
    socket.event({ type: 'session.updated', session: { id: 'vendor-session', model: config.model } });
    await tick(); return { pending, socket };
  }
  const first = await start();
  first.socket.event({ type: 'response.created', response: { id: 'r1', status: 'in_progress' } });
  first.socket.event({ type: 'response.audio_transcript.done', response_id: 'r1', item_id: 'q1', transcript: '请说明你如何核对数据。' });
  first.socket.event({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
  await service.control({ callId: identity.callId, ownerId: 'page', action: 'audio', seq: 0, audioBase64: Buffer.alloc(3200).toString('base64') });
  first.socket.event({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  first.socket.event({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  const pausing = service.control({ callId: identity.callId, ownerId: 'page', action: 'pause' });
  const pausingAgain = service.control({ callId: identity.callId, ownerId: 'page', action: 'pause' });
  await tick();
  assert.equal(first.socket.readyState, 1, 'the socket remains open for the last ASR final after the local microphone stops');
  assert.equal(first.socket.sent.some(event => event.type === 'input_audio_buffer.commit'), false, 'already committed input needs no empty commit');
  await assert.rejects(service.control({ callId: identity.callId, ownerId: 'page', action: 'audio', seq: 1, audioBase64: 'AAA=' }), { code: 'realtime-not-ready' });
  first.socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '  我先检查重复记录，\r\n再核对缺失值。  ' });
  assert.equal((await pausing).reason, 'PAUSED'); assert.equal((await pausingAgain).reason, 'PAUSED'); await first.pending;
  let state = (await career.dispatch('state')).interviews.find(row => row.id === interview.id);
  assert.equal(state.status, 'paused'); assert.equal(state.questions.length, 1);
  assert.equal(state.questions[0].answer.text, '  我先检查重复记录，\r\n再核对缺失值。  ');
  assert.equal(state.questions[0].answer.source, 'realtime-input-transcript'); assert.equal(state.voiceReviewed, false);
  assert.equal(career.realtime.entries(interview.id).length, 2); assert.equal(career.realtime.pending(interview.id).length, 0);
  assert.equal(mirrored.length, 2); assert.equal(mirrored[1].role, 'user');
  assert.equal(first.socket.sent.some(event => event.type === 'conversation.item.create'), false, 'no fabricated provider user messages');
  const second = await start();
  assert.equal(identity.epoch, 2); assert.equal(second.socket.sent[0].session.instructions.includes('我先检查重复记录'), true);
  first.socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'late replacement' });
  await service.control({ callId: identity.callId, ownerId: 'page', action: 'end' }); await second.pending;
  assert.equal(second.socket.sent.some(event => event.type === 'input_audio_buffer.commit'), false, 'a connection with no input must not commit');
  state = (await career.dispatch('state')).interviews.find(row => row.id === interview.id);
  assert.equal(state.questions[0].answer.text.includes('late replacement'), false);
  const third = await start();
  await service.control({ callId: identity.callId, ownerId: 'page', action: 'audio', seq: 0, audioBase64: Buffer.alloc(3200).toString('base64') });
  third.socket.event({ type: 'input_audio_buffer.speech_started', item_id: 'lost-final' });
  third.socket.event({ type: 'input_audio_buffer.committed', item_id: 'lost-final' });
  third.socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'lost-final', text: '不能用草稿', stash: '伪造最终回答' });
  const timedOut = await service.control({ callId: identity.callId, ownerId: 'page', action: 'end' }); await third.pending;
  assert.equal(timedOut.reason, 'transcript-incomplete'); assert.equal(third.socket.readyState, 3);
  assert.equal(career.realtime.entries(interview.id).length, 2, 'all previous final records remain; the draft does not become an answer');
  assert.equal((await career.dispatch('state')).interviews.find(row => row.id === interview.id).lastError, 'transcript-incomplete');
  third.socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'lost-final', transcript: 'late after timeout' });
  await tick(); assert.equal(career.realtime.entries(interview.id).length, 2);
});

test('abort and disable preempt graceful finalization immediately; repeated controls share a single stop without deadlock', { timeout: 1500 }, async t => {
  for (const action of ['abort', 'disable']) {
    const f = fixture(t), controller = new AbortController(), waiting = deferred();
    const run = await f.running({}, { signal: controller.signal }); let finishes = 0;
    run.provider.finishInput = () => { finishes++; return waiting.promise; };
    const ending = f.service.control({ callId: run.callId, ownerId: 'page-1', action: 'end' });
    const endingAgain = f.service.control({ callId: run.callId, ownerId: 'page-1', action: 'end' });
    await tick(); assert.equal(finishes, 1); assert.equal(run.provider.closes, 0);
    if (action === 'abort') controller.abort(); else await f.service.close();
    await ending; await endingAgain; await run.pending;
    assert.equal(run.provider.closes, 1); assert.equal(f.ends.length, 1); assert.equal(f.recorders[0].closes, 1);
    waiting.resolve({ complete: true }); await tick(); assert.equal(f.ends.length, 1);
  }
});

test('graceful finishing drains async native-record receipts before ENDED and never accepts new microphone chunks', async t => {
  const f = fixture(t), run = await f.running(); emitQuestion(run.provider); emitStart(run.provider); await tick();
  const final = deferred(), recorded = deferred(), mirrorGate = deferred(); let finishes = 0;
  const originalRecord = f.recorders[0].recordTurn;
  f.recorders[0].recordTurn = async eventId => { recorded.resolve(); await mirrorGate.promise; await originalRecord(eventId); };
  run.provider.finishInput = async () => { finishes++; await final.promise;
    run.provider.emit({ type: 'input-transcript', itemId: 'user-1', text: '停止麦克风后的最终识别' }); return { complete: true }; };
  const ending = f.service.control({ callId: run.callId, ownerId: 'page-1', action: 'end' });
  await tick(); assert.equal(finishes, 1);
  await assert.rejects(f.service.control({ callId: run.callId, ownerId: 'page-1', action: 'audio', seq: 0, audioBase64: 'AAA=' }), { code: 'realtime-not-ready' });
  final.resolve(); await recorded.promise; await tick();
  assert.equal(run.provider.closes, 0, 'the final NDJSON event must wait for its native receipt before transport shutdown');
  mirrorGate.resolve(); assert.equal((await ending).reason, 'ENDED'); await run.pending;
  assert.equal(f.rows.find(row => row.role === 'user').text, '停止麦克风后的最终识别');
  assert.equal(f.recorders[0].records.length, 2); assert.equal(f.marks.length, 2);
  const delivered = f.events.findIndex(event => event.type === 'input-transcript' && event.text === '停止麦克风后的最终识别');
  assert.ok(delivered >= 0); assert.ok(f.events.findIndex(event => event.type === 'closed') > delivered);
});
