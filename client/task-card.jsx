import React from 'react';
import { Button } from './components.jsx';

const labels = { 'receipt.undo': 'deskUndone', 'assessment.run': 'taskAssessment', 'rewrite.run': 'taskRewrite', 'rewrite.accept': 'taskAccept',
  'material.upload': 'taskImport', 'material.fetch': 'taskImport', 'material.add': 'taskSaveMaterial', 'material.update': 'taskSaveMaterial',
  'material.confirm': 'taskConfirmMaterial', 'goal.create': 'taskSaveGoal', 'goal.update': 'taskSaveGoal', 'goal.linkMaterial': 'taskLinkMaterial',
  'realtime.create': 'taskPrepareInterview', 'realtime.review': 'taskReviewTranscript', 'interview.finish': 'taskReport', 'conversation.link': 'taskSaveConversation' };

export function TaskCard({ operation, onCancel, onRetry, onOpen, t }) {
  if (!operation) return null;
  const status = { running: 'taskRunning', refreshing: 'taskRefreshing', succeeded: 'taskSucceeded', failed: 'taskFailed', cancelled: 'taskCancelled' }[operation.status];
  if (!status) return null;
  return <section className="zj-task-card" aria-label={t('taskStatus')}><div role="status" aria-live="polite"><strong>{t(labels[operation.action] || 'processing')}</strong><span className="zj-subtle">{t(status)}</span></div>
    {operation.canCancel && <Button small onClick={() => { void onCancel?.(operation.requestId); }}>{t('cancelTask')}</Button>}
    {operation.canRetry && onRetry && <Button small onClick={onRetry}>{t('retry')}</Button>}
    {operation.status === 'succeeded' && operation.receipt?.target && onOpen && <Button small onClick={() => onOpen(operation.receipt.target)}>{t('deskOpenResult')}</Button>}
  </section>;
}

export function ReceiptList({ receipts = [], onOpen, onUndo, busy, t }) {
  if (!receipts.length) return null;
  return <details className="zj-receipts"><summary>{t('deskReceipts')} · {receipts.length}</summary><div>{receipts.slice(0, 30).map(receipt => <div className="zj-receipt" key={receipt.id}><div><strong>{t(labels[receipt.action] || 'taskSucceeded')}</strong><time dateTime={receipt.createdAt}>{receipt.createdAt.slice(0, 16).replace('T', ' ')}</time></div><div className="zj-actions"><Button small quiet onClick={() => onOpen(receipt.target)}>{t('deskOpenResult')}</Button><Button small quiet disabled={busy || !receipt.undo.available} title={t(receipt.undo.reasonCode === 'UNDO_CONFLICT' ? 'deskUndoConflict' : receipt.undo.reasonCode === 'UNDO_USED' ? 'deskUndoUsed' : receipt.undo.available ? 'deskUndoNote' : 'deskUndoUnavailable')} onClick={() => onUndo(receipt)}>{t('deskUndo')}</Button></div></div>)}</div></details>;
}
