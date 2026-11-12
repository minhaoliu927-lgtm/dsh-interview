import React from 'react';
import { Button } from './components.jsx';

const labels = { 'assessment.run': 'taskAssessment', 'rewrite.run': 'taskRewrite', 'rewrite.accept': 'taskAccept',
  'material.upload': 'taskImport', 'material.fetch': 'taskImport', 'material.add': 'taskSaveMaterial', 'material.update': 'taskSaveMaterial',
  'material.confirm': 'taskConfirmMaterial', 'goal.create': 'taskSaveGoal', 'goal.update': 'taskSaveGoal', 'goal.linkMaterial': 'taskLinkMaterial',
  'realtime.create': 'taskPrepareInterview', 'realtime.review': 'taskReviewTranscript', 'interview.finish': 'taskReport', 'conversation.link': 'taskSaveConversation' };

export function TaskCard({ operation, onCancel, t }) {
  if (!operation) return null;
  const status = { running: 'taskRunning', refreshing: 'taskRefreshing', succeeded: 'taskSucceeded', failed: 'taskFailed', cancelled: 'taskCancelled' }[operation.status];
  if (!status) return null;
  return <section className="zj-task-card" aria-label={t('taskStatus')}><div role="status" aria-live="polite"><strong>{t(labels[operation.action] || 'processing')}</strong><span className="zj-subtle">{t(status)}</span></div>
    {operation.canCancel && <Button small onClick={() => { void onCancel?.(operation.requestId); }}>{t('cancelTask')}</Button>}
  </section>;
}
