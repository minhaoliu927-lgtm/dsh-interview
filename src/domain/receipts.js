import { id, now, fail, label } from './validation.js';

// Receipts describe committed operations. Undo is a checked compensating write,
// never deletion of a model result, an immutable version, or native chat history.
export const RECEIPT_SYNC_ACTIONS = new Set(['material.add', 'material.update', 'material.confirm', 'goal.create', 'goal.update', 'goal.linkMaterial', 'conversation.link', 'rewrite.accept', 'receipt.undo']);
const actions = new Set([...RECEIPT_SYNC_ACTIONS, 'assessment.run', 'rewrite.run', 'interview.start', 'interview.answer', 'interview.pause', 'interview.resume', 'interview.finish']);
export function createReceiptLedger({ store, material, version, goal, artifact, addVersion }) {
  const { db } = store;
  function capture(action, input) {
    if (action === 'material.update') return material(input.materialId);
    if (action === 'rewrite.accept') return material(artifact(input.rewriteId, 'rewrite').materialId);
    if (['goal.update', 'goal.linkMaterial'].includes(action)) return goal(input.goalId);
    return null;
  }
  function targetFor(action, value) {
    if (action === 'material.confirm') return { kind: 'material', id: value.materialId, versionId: value.id };
    if (action.startsWith('material.')) return { kind: 'material', id: value.id, versionId: value.latestVersionId };
    if (action.startsWith('goal.')) return { kind: 'goal', id: value.id };
    if (action === 'rewrite.accept') return { kind: 'material', id: value.version.materialId, versionId: value.version.id };
    if (action === 'conversation.link') return { kind: 'conversation', id: value.id, sessionId: value.sessionId, goalId: value.goalId };
    if (action === 'assessment.run' || action === 'rewrite.run') return { kind: action.split('.')[0], id: value.id, goalId: value.goalId, versionId: value.versionId };
    if (action.startsWith('interview.')) return { kind: value.reportId ? 'report' : 'interview', id: value.reportId || value.id, sessionId: value.sessionId, goalId: value.goalId };
    return null;
  }
  function reason(row) {
    if (row.used_at) return 'UNDO_USED';
    if (!row.undo_json) return 'UNDO_UNAVAILABLE';
    const undo = JSON.parse(row.undo_json);
    try {
      if (undo.kind === 'version') {
        const current = material(undo.id);
        if (current.latestVersionId !== undo.afterVersionId || current.title !== undo.afterTitle) return 'UNDO_CONFLICT';
      } else if (undo.kind === 'goal') {
        const current = goal(undo.id);
        if (Object.entries(undo.after).some(([key, value]) => current[key] !== value)) return 'UNDO_CONFLICT';
      } else if (undo.kind === 'link') {
        const current = goal(undo.id);
        if (current.status !== 'active' || current.materialLinks.find(value => value.kind === undo.materialKind)?.versionId !== undo.afterVersionId) return 'UNDO_CONFLICT';
      } else if (undo.kind === 'createGoal') {
        const current = goal(undo.id);
        if (current.status !== 'active' || current.updatedAt !== undo.updatedAt || Object.entries(undo.after).some(([key, value]) => current[key] !== value) || current.conversations.length || current.materialLinks.length
          || db.prepare('SELECT data_json FROM artifacts').all().some(value => JSON.parse(value.data_json).goalId === current.id)) return 'UNDO_CONFLICT';
      }
    } catch { return 'UNDO_CONFLICT'; }
    return null;
  }
  function publicReceipt(row) {
    const reasonCode = reason(row);
    return { id: row.id, action: row.action, createdAt: row.created_at, target: JSON.parse(row.target_json),
      undo: { available: !reasonCode, reasonCode, usedAt: row.used_at || null } };
  }
  function insert(action, target, undo) {
    const row = { id: id(), action, target_json: JSON.stringify(target), undo_json: undo ? JSON.stringify(undo) : null, created_at: now(), used_at: null };
    db.prepare('INSERT INTO operation_receipts(id,action,target_json,undo_json,created_at) VALUES(?,?,?,?,?)').run(row.id, action, row.target_json, row.undo_json, row.created_at);
    return publicReceipt(row);
  }
  function record(action, input, value, before) {
    if (!actions.has(action) || action === 'receipt.undo' || !value || value.reused) return value;
    const target = targetFor(action, value);
    if (!target?.id) return value;
    let undo = null;
    if (action === 'goal.create') undo = { kind: 'createGoal', id: value.id, updatedAt: value.updatedAt, after: { title: value.title, company: value.company, description: value.description } };
    if (action === 'goal.update') {
      const keys = ['title', 'company', 'description', 'status'].filter(key => input[key] !== undefined && before[key] !== value[key]);
      if (keys.length) undo = { kind: 'goal', id: value.id, before: Object.fromEntries(keys.map(key => [key, before[key]])), after: Object.fromEntries(keys.map(key => [key, value[key]])) };
    }
    if (action === 'goal.linkMaterial') {
      const selected = version(input.versionId);
      const priorVersionId = before.materialLinks.find(row => row.kind === selected.kind)?.versionId || null;
      if (priorVersionId !== selected.id) undo = { kind: 'link', id: value.id, materialKind: selected.kind, priorVersionId, afterVersionId: selected.id };
    }
    if (action === 'material.update' || action === 'rewrite.accept') undo = { kind: 'version', id: target.id, beforeVersionId: before.latestVersionId,
      beforeTitle: before.title, afterTitle: material(target.id).title, afterVersionId: target.versionId };
    return { ...value, receipt: insert(action, target, undo) };
  }
  function undo(input) {
    const row = db.prepare('SELECT * FROM operation_receipts WHERE id=?').get(label(input.receiptId, 200));
    if (!row) fail('RECEIPT_NOT_FOUND');
    const conflict = reason(row);
    if (conflict) fail(conflict, conflict === 'UNDO_CONFLICT' ? '结果已发生变化，无法撤销这一步。' : '这一步不能再次撤销。');
    const operation = JSON.parse(row.undo_json);
    let target = JSON.parse(row.target_json);
    if (operation.kind === 'version') {
      const prior = version(operation.beforeVersionId);
      const restored = addVersion(operation.id, prior.text, { kind: 'undo', receiptId: row.id, restoredVersionId: prior.id });
      db.prepare('UPDATE materials SET title=? WHERE id=?').run(operation.beforeTitle, operation.id);
      target = { kind: 'material', id: operation.id, versionId: restored.id };
    } else if (operation.kind === 'goal') {
      const restored = { ...goal(operation.id), ...operation.before };
      db.prepare('UPDATE goals SET title=?,company=?,description=?,status=?,updated_at=? WHERE id=?').run(restored.title, restored.company, restored.description, restored.status, now(), restored.id);
    } else if (operation.kind === 'link') {
      if (operation.priorVersionId) db.prepare('UPDATE goal_materials SET version_id=?,created_at=? WHERE goal_id=? AND kind=?').run(operation.priorVersionId, now(), operation.id, operation.materialKind);
      else db.prepare('DELETE FROM goal_materials WHERE goal_id=? AND kind=?').run(operation.id, operation.materialKind);
    } else if (operation.kind === 'createGoal') db.prepare("UPDATE goals SET status='archived',updated_at=? WHERE id=?").run(now(), operation.id);
    db.prepare('UPDATE operation_receipts SET used_at=? WHERE id=?').run(now(), row.id);
    return { receipt: insert('receipt.undo', target, null), undoneReceiptId: row.id };
  }
  return { capture, record, undo, list: () => db.prepare('SELECT * FROM operation_receipts ORDER BY created_at DESC,rowid DESC LIMIT 100').all().map(publicReceipt) };
}
