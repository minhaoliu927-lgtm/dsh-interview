import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const owners = new Set();
const lifecycle = new Set(['session/title', 'session/end-seed']);
const fail = code => { throw Object.assign(new Error(code), { code, status: 409 }); };
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 300;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const messageId = (sessionId, entryId) => `zhijing-voice-${digest([sessionId, entryId])}`;

function snapshotLedger(value, sessionId, interviewId) {
  if (!value || value.sessionId !== sessionId || value.interviewId !== interviewId || !Array.isArray(value.entries)) fail('VOICE_LEDGER_OWNERSHIP');
  const ledger = structuredClone(value), ids = new Set(), keys = new Set();
  for (const entry of ledger.entries) {
    if (typeof entry?.createdAt === 'string') entry.createdAt = Date.parse(entry.createdAt);
    if (!entry || !identity(entry.id) || !identity(entry.eventKey) || !identity(entry.callId)
      || !['user', 'assistant'].includes(entry.role) || typeof entry.text !== 'string' || !entry.text.trim()
      || entry.text.length > 200_000 || !identity(entry.provider) || !identity(entry.model)
      || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0
      || (entry.interrupted !== undefined && typeof entry.interrupted !== 'boolean')) fail('VOICE_LEDGER_INVALID');
    const key = JSON.stringify([entry.callId, entry.role, entry.eventKey]);
    if (ids.has(entry.id) || keys.has(key)) fail('VOICE_LEDGER_DUPLICATE');
    ids.add(entry.id); keys.add(key);
  }
  return ledger;
}

/** One finalized provider event is one independent turn; input may arrive late. */
function specifications(ledger) {
  return ledger.entries.flatMap((entry, index) => {
    const turn = index + 1, step = 1;
    const marker = { version: 1, interviewId: ledger.interviewId, entryId: entry.id,
      eventKey: entry.eventKey, callId: entry.callId, provider: entry.provider, model: entry.model,
      createdAt: entry.createdAt, interrupted: entry.interrupted === true };
    const message = { id: messageId(ledger.sessionId, entry.id), role: entry.role,
      content: [{ type: 'text', text: entry.text }], source: entry.role === 'user'
        ? { kind: 'user', rpcId: `zhijing-realtime-${digest(marker)}` }
        : { kind: 'model', provider: entry.provider, model: entry.model, replayState: { zhijingRealtime: marker } } };
    const recorded = entry.role === 'user'
      ? { type: 'user/message', data: message, surfaceOp: 'append' }
      : { type: 'assistant/message', data: { turn, step, message,
        // This adapter receives a finalized transcript event, so it honestly
        // records one text delta at its receive time, not invented word timing.
        stream: [{ type: 'text-chunks', time0: entry.createdAt, index: 0, dt: [], texts: [entry.text] }],
        ...(entry.interrupted ? { interrupted: true } : {}),
      }, surfaceOp: 'append' };
    return [
      { type: 'turn/start', data: { turn } }, { type: 'step/start', data: { turn, step } }, recorded,
      { type: 'step/end', data: { turn, step } }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    ];
  });
}

function reconcile(events, specs) {
  let matched = 0;
  for (const event of events) {
    if (lifecycle.has(event.type)) {
      if (event.type === 'session/end-seed' && matched % 5 !== 0) fail('VOICE_SESSION_PARTIAL_RESUME_CONFLICT');
      continue;
    }
    const expected = specs[matched];
    if (!expected || event.type !== expected.type || !isDeepStrictEqual(event.data, expected.data)
      || !isDeepStrictEqual(event.surfaceOp, expected.surfaceOp) || event.sourceEventSeqs !== undefined) fail('VOICE_SESSION_HISTORY_CONFLICT');
    matched += 1;
  }
  return matched;
}

/**
 * Own one new, interview-only native Session. readLedger returns the committed,
 * immutable append order {sessionId, interviewId, entries:[{id,eventKey,role,text,
 * provider,model,callId,createdAt,interrupted?}]}. Never pass uncommitted input.
 * Uses only public Session, persistence handle and Agent registry APIs.
 */
export function createNativeSessionRecorder({ ctx, sessionId, interviewId, cwd, readLedger }) {
  if (!identity(sessionId) || !/^session-zhijing-realtime-[A-Za-z0-9_-]+$/.test(sessionId)
    || !identity(interviewId) || !isAbsolute(cwd ?? '') || typeof readLedger !== 'function') fail('VOICE_SESSION_CONFIG');
  // Realtime support is optional in the production plugin. Cordis throws on
  // direct ctx.service access unless that service was declared in inject;
  // ctx.get is its public optional-service lookup and preserves the scope.
  const service = name => typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name];
  const sessions = service('sessions'), persistence = service('sessionPersistence'), agents = service('agents');
  if (!['get', 'prepare', 'enter', 'announce', 'flush'].every(key => typeof sessions?.[key] === 'function')
    || !['stat', 'open', 'create'].every(key => typeof persistence?.[key] === 'function')
    || typeof agents?.get !== 'function') fail('VOICE_SESSION_HOST_UNAVAILABLE');
  let session, writer, detach, state = 'new', owns = false, queue = Promise.resolve();
  const serial = operation => { const result = queue.then(operation); queue = result.catch(() => {}); return result; };
  const ledger = async () => snapshotLedger(await readLedger(), sessionId, interviewId);
  const requireFree = () => {
    // Even an idle Agent owns its native Session. Do not steal its next turn.
    if (agents.get(sessionId)) fail('VOICE_SESSION_AGENT_OWNED');
    const current = sessions.get(sessionId);
    if (current && current !== session) fail('VOICE_SESSION_ALREADY_OPEN');
  };
  const release = async () => {
    try { await writer?.close(); }
    finally { writer = undefined; detach?.(); detach = undefined; session = undefined;
      if (owns) owners.delete(sessionId); owns = false; }
  };
  const api = {
    open: () => serial(async () => {
      if (state === 'open') return { sessionId, recoveredEntries: 0 };
      if (state !== 'new') fail('VOICE_SESSION_CLOSED');
      requireFree();
      if (owners.has(sessionId)) fail('VOICE_SESSION_ALREADY_OPEN');
      owners.add(sessionId); owns = true;
      try {
        const committed = await ledger(), specs = specifications(committed);
        requireFree();
        const exists = await persistence.stat(sessionId);
        let stored = [], options;
        if (exists) {
          writer = await persistence.open(sessionId, 'write');
          if (writer.header.cwd !== cwd) fail('VOICE_SESSION_WORKSPACE_CONFLICT');
          const read = await writer.read();
          stored = read.events;
          const matched = reconcile(stored, specs);
          const missing = specs.slice(matched).map((spec, index) => ({ ...spec, seq: stored.length + index, time: Date.now() }));
          // prepare validates the entire recovered surface before any repair
          // is persisted, and supplies its own documented resume marker.
          options = { seed: [...stored, ...missing], meta: structuredClone(writer.header),
            inheritedEventCount: writer.inheritedEventCount, eventState: read.eventState };
          session = sessions.prepare(sessionId, options);
          const suffix = session.snapshotEvents().slice(stored.length);
          if (suffix.length) await writer.append(suffix);
          await writer.flush();
        } else {
          session = sessions.prepare(sessionId, { meta: { cwd } });
          writer = await persistence.create(session.header);
        }
        requireFree();
        detach = sessions.enter(session);
        sessions.announce(session);
        const matched = reconcile(session.snapshotEvents(), specs);
        for (const spec of specs.slice(matched)) session.append(spec.type, spec.data, ...(spec.surfaceOp ? [{ surfaceOp: spec.surfaceOp }] : []));
        if (await sessions.flush(session) !== true) fail('VOICE_SESSION_NOT_DURABLE');
        state = 'open';
        return { sessionId, recoveredEntries: committed.entries.length - Math.floor(reconcile(stored, specs) / 5) };
      } catch (error) { state = 'failed'; try { await release(); } catch {} throw error; }
    }),
    recordTurn: entryId => serial(async () => {
      if (state !== 'open') fail('VOICE_SESSION_CLOSED');
      requireFree();
      if (sessions.get(sessionId) !== session) fail('VOICE_SESSION_OWNERSHIP_LOST');
      const committed = await ledger();
      requireFree();
      const index = committed.entries.findIndex(entry => entry.id === entryId);
      if (index < 0) fail('VOICE_LEDGER_ENTRY_NOT_COMMITTED');
      const specs = specifications(committed);
      const matched = reconcile(session.snapshotEvents(), specs);
      const duplicate = matched >= (index + 1) * 5;
      // No await between individual public appends. A crash can still persist
      // a prefix; open() repairs that prefix from the committed ledger.
      for (const spec of specs.slice(matched)) session.append(spec.type, spec.data, ...(spec.surfaceOp ? [{ surfaceOp: spec.surfaceOp }] : []));
      if (await sessions.flush(session) !== true) fail('VOICE_SESSION_NOT_DURABLE');
      return { sessionId, entryId, messageId: messageId(sessionId, entryId), duplicate };
    }),
    close: () => serial(async () => {
      if (state === 'closed') return;
      state = 'closed';
      try { if (session && writer) await sessions.flush(session); }
      finally { await release(); }
    }),
  };
  return api;
}
