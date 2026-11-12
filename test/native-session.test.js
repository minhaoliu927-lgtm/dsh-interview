import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNativeSessionRecorder } from '../src/voice/native-session.js';

// Small public-interface double for fault injection. The separate plugin-host
// proof runs the same production recorder against actual DSH persistence.
function harness(storage = new Map()) {
  const sessions = new Map(), agents = new Map(), writers = new Map();
  let failAfter = Infinity, appendCount = 0;
  function prepare(id, options = {}) {
    const events = structuredClone(options.seed ?? []);
    if (options.seed && events.at(-1)?.type !== 'session/end-seed') events.push({ type: 'session/end-seed', data: {}, seq: events.length, time: Date.now() });
    return { id, header: options.meta?.version ? options.meta : { id, version: 4, createdAt: Date.now(), isSeeded: false, ...options.meta },
      snapshotEvents: () => structuredClone(events),
      append(type, data, surface) {
        if (appendCount++ === failAfter) throw new Error('INJECTED_CRASH_PREFIX');
        const event = { type, data: structuredClone(data), seq: events.length, time: Date.now(), ...surface };
        events.push(event); writers.get(id)?.events.push(structuredClone(event)); return event;
      } };
  }
  function writer(id) {
    if (writers.has(id)) throw new Error('WRITE_OWNERSHIP_BUSY');
    const value = storage.get(id), handle = { header: structuredClone(value.header), inheritedEventCount: 0, events: structuredClone(value.events),
      read: async () => ({ events: structuredClone(handle.events), eventState: 'detached' }),
      append: async events => { for (const event of events) { assert.equal(event.seq, handle.events.length); handle.events.push(structuredClone(event)); } },
      flush: async () => { value.events = structuredClone(handle.events); },
      close: async () => { await handle.flush(); writers.delete(id); },
    };
    writers.set(id, handle); return handle;
  }
  const ctx = { agents: { get: id => agents.get(id) }, sessions: {
    get: id => sessions.get(id), prepare,
    enter(session) { assert(!sessions.has(session.id)); sessions.set(session.id, session); return () => sessions.delete(session.id); },
    announce() {}, flush: async session => { const current = writers.get(session.id); if (!current) return false; await current.flush(); return true; },
  }, sessionPersistence: {
    stat: async id => storage.has(id) ? { header: storage.get(id).header } : undefined,
    create: async header => { assert(!storage.has(header.id)); storage.set(header.id, { header, events: [] }); return writer(header.id); },
    open: async id => writer(id),
  } };
  return { ctx, storage, agents, sessions, crashAfter(count) { appendCount = 0; failAfter = count; } };
}
const entry = (id, role = 'assistant') => ({ id, eventKey: `provider-${id}`, role, text: role === 'assistant' ? '请介绍一个项目。' : '我负责数据清理。',
  provider: 'synthetic', model: 'protocol-only', callId: 'call-1', createdAt: '2026-11-12T00:00:00.000Z' });
function fixture(h = harness()) {
  const ledger = { sessionId: `session-zhijing-realtime-${randomUUID()}`, interviewId: 'interview-test', entries: [] };
  const create = (host = h) => createNativeSessionRecorder({ ctx: host.ctx, sessionId: ledger.sessionId, interviewId: ledger.interviewId,
    cwd: process.cwd(), readLedger: async () => structuredClone(ledger) });
  return { h, ledger, create };
}

test('uses public optional service lookup in a context without native service injections', async () => {
  const f = fixture(), reads = [];
  const ctx = new Proxy({ get(name) { reads.push(name); return f.h.ctx[name]; } }, {
    get(target, key, receiver) {
      if (['sessions', 'sessionPersistence', 'agents'].includes(key)) throw new Error('DIRECT_SERVICE_ACCESS_WITHOUT_INJECT');
      return Reflect.get(target, key, receiver);
    },
  });
  const create = () => createNativeSessionRecorder({ ctx, sessionId: f.ledger.sessionId, interviewId: f.ledger.interviewId,
    cwd: process.cwd(), readLedger: () => structuredClone(f.ledger) });
  const recorder = create();
  try {
    await recorder.open();
    f.ledger.entries.push(entry('optional-services'));
    await recorder.recordTurn('optional-services');
  } finally { await recorder.close(); }
  const restored = create();
  try { await restored.open(); assert.equal((await restored.recordTurn('optional-services')).duplicate, true); }
  finally { await restored.close(); }
  assert.deepEqual([...new Set(reads)], ['sessions', 'sessionPersistence', 'agents']);
  assert.equal(f.h.sessions.size, 0);
});

test('refuses unavailable or incomplete optional native services before writing', () => {
  for (const missing of ['sessions', 'sessionPersistence', 'agents']) {
    for (const replacement of [undefined, {}]) {
      const f = fixture(), ctx = { get: name => name === missing ? replacement : f.h.ctx[name] };
      assert.throws(() => createNativeSessionRecorder({ ctx, sessionId: f.ledger.sessionId, interviewId: f.ledger.interviewId,
        cwd: process.cwd(), readLedger: () => structuredClone(f.ledger) }), { code: 'VOICE_SESSION_HOST_UNAVAILABLE' });
      assert.equal(f.h.storage.size, 0);
      assert.equal(f.h.sessions.size, 0);
    }
  }
});

test('records assistant-only opening and late user in ledger order without an Agent', async () => {
  const f = fixture(), recorder = f.create();
  try {
    await recorder.open();
    f.ledger.entries.push(entry('opening'));
    const first = await recorder.recordTurn('opening'); assert.equal(first.duplicate, false);
    f.ledger.entries.push(entry('late-input', 'user'));
    await recorder.recordTurn('late-input');
    const duplicate = await recorder.recordTurn('opening'); assert.equal(duplicate.messageId, first.messageId); assert.equal(duplicate.duplicate, true);
    const events = f.h.storage.get(f.ledger.sessionId).events;
    assert.deepEqual(events.filter(value => value.type.endsWith('/message')).map(value => value.type), ['assistant/message', 'user/message']);
    assert.equal(f.h.agents.size, 0);
  } finally { await recorder.close(); }
});

test('serializes simultaneous delivery and rejects uncommitted events', async () => {
  const f = fixture(), recorder = f.create();
  try {
    await recorder.open();
    await assert.rejects(recorder.recordTurn('not-saved'), { code: 'VOICE_LEDGER_ENTRY_NOT_COMMITTED' });
    f.ledger.entries.push(entry('same'));
    const results = await Promise.all([recorder.recordTurn('same'), recorder.recordTurn('same')]);
    assert.deepEqual(results.map(result => result.duplicate), [false, true]);
    assert.equal(f.h.storage.get(f.ledger.sessionId).events.filter(value => value.type === 'assistant/message').length, 1);
  } finally { await recorder.close(); }
});

for (const prefix of [1, 2, 3, 4]) test(`repairs a ${prefix}-event partial turn from the committed ledger without duplicate messages`, async () => {
  const f = fixture(), recorder = f.create();
  await recorder.open();
  f.ledger.entries.push(entry('crashed', prefix % 2 ? 'user' : 'assistant'));
  f.h.crashAfter(prefix);
  await assert.rejects(recorder.recordTurn('crashed'), /INJECTED_CRASH_PREFIX/);
  await recorder.close();
  assert.equal(f.h.storage.get(f.ledger.sessionId).events.length, prefix);
  const restarted = harness(f.h.storage), restored = f.create(restarted);
  try {
    const result = await restored.open(); assert.equal(result.recoveredEntries, 1);
    const duplicate = await restored.recordTurn('crashed'); assert.equal(duplicate.duplicate, true);
    const events = restarted.storage.get(f.ledger.sessionId).events;
    assert.equal(events.filter(value => value.type.endsWith('/message')).length, 1);
    assert.equal(events.filter(value => value.type === 'turn/end').length, 1);
    assert.equal(events.filter(value => value.type === 'session/end-seed').length, 1);
  } finally { await restored.close(); }
});

test('refuses active or idle Agent ownership and other live Sessions', async () => {
  const f = fixture();
  f.h.agents.set(f.ledger.sessionId, { running: false });
  await assert.rejects(f.create().open(), { code: 'VOICE_SESSION_AGENT_OWNED' });
  f.h.agents.clear(); f.h.sessions.set(f.ledger.sessionId, {});
  await assert.rejects(f.create().open(), { code: 'VOICE_SESSION_ALREADY_OPEN' });
  f.h.sessions.clear();
  const first = f.create(), second = f.create();
  try { await first.open(); await assert.rejects(second.open(), { code: 'VOICE_SESSION_ALREADY_OPEN' }); }
  finally { await first.close(); await second.close(); }
});

test('rejects immutable ledger edits, another interview, and foreign stored history', async () => {
  const f = fixture(), recorder = f.create();
  await recorder.open(); f.ledger.entries.push(entry('one')); await recorder.recordTurn('one'); await recorder.close();
  const saved = structuredClone(f.h.storage.get(f.ledger.sessionId));
  f.ledger.entries[0].text = '被改写的旧内容';
  await assert.rejects(f.create(harness(f.h.storage)).open(), { code: 'VOICE_SESSION_HISTORY_CONFLICT' });
  assert.deepEqual(f.h.storage.get(f.ledger.sessionId), saved);
  f.ledger.interviewId = 'other-interview';
  await assert.rejects(f.create(harness(f.h.storage)).open(), { code: 'VOICE_SESSION_HISTORY_CONFLICT' });
});

test('reports lost ownership and preserves interrupted transcript markers', async () => {
  const f = fixture(), recorder = f.create();
  try {
    await recorder.open(); f.ledger.entries.push({ ...entry('cut-off'), interrupted: true }); await recorder.recordTurn('cut-off');
    const event = f.h.storage.get(f.ledger.sessionId).events.find(value => value.type === 'assistant/message');
    assert.equal(event.data.interrupted, true);
    f.h.agents.set(f.ledger.sessionId, { running: true });
    await assert.rejects(recorder.recordTurn('cut-off'), { code: 'VOICE_SESSION_AGENT_OWNED' });
    f.h.agents.clear();
  } finally { await recorder.close(); }
});

test('user event provenance cannot change under the same ledger identity', async () => {
  const f = fixture(), recorder = f.create();
  await recorder.open(); f.ledger.entries.push(entry('human', 'user')); await recorder.recordTurn('human'); await recorder.close();
  f.ledger.entries[0].model = 'changed-provider-route';
  await assert.rejects(f.create(harness(f.h.storage)).open(), { code: 'VOICE_SESSION_HISTORY_CONFLICT' });
});
