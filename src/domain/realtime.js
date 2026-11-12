import { id, now, hash, fail, label, text, integer, choice, list } from './validation.js';

/** Internal, authenticated provider events only. Never exposed as a chat tool. */
export function createRealtimeLedger({ store, interview, saveInterview, taskSnapshots, linkConversation }) {
  const { db } = store;
  const findCall = (callId, epoch, active = true) => {
    const row = db.prepare('SELECT * FROM realtime_calls WHERE id=?').get(label(callId));
    if (!row || row.epoch !== epoch || (active && row.status !== 'active')) fail('REALTIME_CALL_CHANGED');
    return row;
  };
  function mapped(row) {
    return { id: row.id, callId: row.call_id, key: row.event_key, role: row.role, text: row.text, hash: row.text_hash,
      questionId: row.question_id, createdAt: row.created_at, ...JSON.parse(row.data_json) };
  }
  return {
    create(input, options = {}) {
      return store.transaction(() => {
      const sessionId = label(input.sessionId ?? options.sessionId, 200);
      linkConversation({ goalId: input.goalId, versionId: input.versionId, sessionId, kind: 'interview', title: input.language === 'en' ? 'Voice interview' : '语音面试' });
      const data = taskSnapshots({ ...input, sessionId }, options, true);
      const prior = db.prepare('SELECT * FROM conversations WHERE session_id=?').get(sessionId);
      if (!prior || prior.kind !== 'interview' || prior.goal_id !== data.target.id) fail('INTERVIEW_SESSION_IN_USE');
      if (db.prepare('SELECT id FROM interviews WHERE session_id=?').get(sessionId)) fail('INTERVIEW_SESSION_IN_USE');
      const value = { id: id(), mode: 'realtime', workspaceId: input.workspaceId ?? null, goalId: data.target.id, versionId: data.selected.id, sessionId,
        status: 'paused', language: choice(input.language ?? 'zh', ['zh', 'en']), questionCount: integer(input.questionCount ?? 5, 1, 10),
        voiceEpoch: 0, voiceReviewed: false, goalSnapshot: { id: data.target.id, title: data.target.title, company: data.target.company },
        snapshots: data.snapshots, questions: [], currentQuestionId: null, reportId: null, lastError: null, createdAt: now(), updatedAt: now() };
      db.prepare('INSERT INTO interviews(id,goal_id,version_id,session_id,status,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(value.id, value.goalId, value.versionId, sessionId, value.status, JSON.stringify(value), value.createdAt, value.updatedAt);
      return value;
      });
    },
    begin({ interviewId, provider, model }) {
      return store.transaction(() => {
        const value = interview(interviewId);
        if (value.mode !== 'realtime' || value.status === 'completed') fail('REALTIME_INTERVIEW_REQUIRED');
        if (db.prepare('SELECT status FROM goals WHERE id=?').get(value.goalId)?.status !== 'active') fail('GOAL_ARCHIVED');
        if (db.prepare("SELECT id FROM realtime_calls WHERE interview_id=? AND status='active'").get(value.id)) fail('REALTIME_IN_USE');
        const callId = id(), epoch = (value.voiceEpoch ?? 0) + 1;
        db.prepare('INSERT INTO realtime_calls(id,interview_id,epoch,status,provider,model,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(callId, value.id, epoch, 'active', label(provider), label(model), now());
        const current = saveInterview({ ...value, status: 'active', voiceEpoch: epoch, voiceReviewed: false, lastError: null });
        return { callId, epoch, interview: current };
      });
    },
    /** key is the provider's stable item/response identity, scoped to this call. */
    record({ callId, epoch, key, role, text: content, questionId = null, interrupted = false, playedMs = null, providerItemId = null }) {
      return store.transaction(() => {
        const call = findCall(callId, epoch);
        choice(role, ['user', 'assistant']); label(key, 300); text(content, 30_000);
        if (playedMs !== null) integer(playedMs, 0, 3_600_000);
        const prior = db.prepare('SELECT * FROM realtime_events WHERE call_id=? AND event_key=?').get(callId, key);
        if (prior) {
          if (prior.role !== role || prior.text !== content || (role === 'user' && prior.question_id !== questionId)) fail('REALTIME_EVENT_CONFLICT');
          return { ...mapped(prior), duplicate: true };
        }
        const value = interview(call.interview_id), eventId = id(), timestamp = now();
        if (role === 'assistant') {
          questionId = eventId;
          value.questions.push({ id: questionId, text: content, competency: value.language === 'en' ? 'Interview conversation' : '面试对话',
            kind: 'conversation', evidence: [], answer: null, evaluation: null, realtimeEventId: eventId, interrupted: Boolean(interrupted) });
          value.currentQuestionId = questionId;
        } else {
          const question = value.questions.find(item => item.id === questionId);
          // A user utterance without an observed interviewer turn remains a transcript,
          // not silently attributed to a later question or used as report evidence.
          if (question) {
            const part = { eventId, text: content, hash: hash(content), createdAt: timestamp };
            if (!question.answer) question.answer = { id: id(), text: content, hash: hash(content), createdAt: timestamp,
              source: 'realtime-input-transcript', parts: [part], revisions: [], reviewedAt: null };
            else {
              question.answer.parts.push(part);
              question.answer.text = question.answer.parts.map(item => item.text).join('\n');
              question.answer.hash = hash(question.answer.text);
              question.answer.reviewedAt = null;
            }
          } else {
            questionId = null;
            (value.unassignedTranscripts ??= []).push({ eventId, text: content, hash: hash(content), createdAt: timestamp });
          }
        }
        const details = { sessionId: value.sessionId, epoch, provider: call.provider, model: call.model,
          interrupted: Boolean(interrupted), playedMs, providerItemId: providerItemId === null ? null : label(providerItemId, 300),
          source: role === 'user' ? 'provider-input-transcript' : 'provider-output-transcript' };
        db.prepare('INSERT INTO realtime_events(id,call_id,event_key,role,text,text_hash,question_id,data_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(eventId, callId, key, role, content, hash(content), questionId, JSON.stringify(details), timestamp);
        saveInterview({ ...value, voiceReviewed: false });
        return mapped(db.prepare('SELECT * FROM realtime_events WHERE id=?').get(eventId));
      });
    },
    end({ callId, epoch, reason = 'PAUSED' }) {
      return store.transaction(() => {
        const call = findCall(callId, epoch, false);
        if (call.status !== 'active') return interview(call.interview_id);
        const status = reason === 'ENDED' ? 'ended' : reason === 'PAUSED' ? 'paused' : 'failed';
        db.prepare('UPDATE realtime_calls SET status=?,reason=?,ended_at=? WHERE id=?').run(status, label(reason), now(), callId);
        return saveInterview({ ...interview(call.interview_id), status: 'paused', lastError: status === 'failed' ? reason : null });
      });
    },
    review({ interviewId, revisions = [] }) {
      const value = interview(interviewId);
      if (value.mode !== 'realtime' || value.status !== 'paused') fail('REALTIME_REVIEW_REQUIRES_PAUSE');
      const edits = new Map();
      for (const edit of list(revisions, 200)) {
        label(edit.answerId); text(edit.text, 30_000);
        if (edits.has(edit.answerId) || !value.questions.some(question => question.answer?.id === edit.answerId)) fail('REALTIME_ANSWER_CHANGED');
        edits.set(edit.answerId, edit.text);
      }
      const timestamp = now();
      for (const question of value.questions) {
        const answer = question.answer;
        if (!answer) continue;
        const edited = edits.get(answer.id);
        if (edited !== undefined && edited !== answer.text) {
          if (answer.revisions.length >= 20) fail('REALTIME_REVISION_LIMIT');
          answer.revisions.push({ id: id(), before: answer.text, after: edited, createdAt: timestamp });
          answer.text = edited; answer.hash = hash(edited);
        }
        answer.reviewedAt = timestamp;
      }
      return saveInterview({ ...value, voiceReviewed: true });
    },
    pending(interviewId) {
      return db.prepare('SELECT e.* FROM realtime_events e JOIN realtime_calls c ON c.id=e.call_id WHERE c.interview_id=? AND e.mirrored_at IS NULL ORDER BY e.rowid')
        .all(label(interviewId)).map(mapped);
    },
    entries(interviewId) {
      return db.prepare('SELECT e.* FROM realtime_events e JOIN realtime_calls c ON c.id=e.call_id WHERE c.interview_id=? ORDER BY e.rowid')
        .all(label(interviewId)).map(mapped);
    },
    markMirrored(eventId) { db.prepare('UPDATE realtime_events SET mirrored_at=COALESCE(mirrored_at,?) WHERE id=?').run(now(), label(eventId)); },
  };
}
