import React from 'react';
import { Button, Evaluation, FormFooter, Lines, Modal, useFormDraft } from './components.jsx';
import { ResumeSelect } from './analysis.jsx';
import { goalHasJob, versionEntry } from './model.js';
import { VoiceAnswer } from './voice-ui.jsx';
import { RealtimeCall } from './voice/realtime-call.jsx';

export function interviewFormDraft(state, selectedVersion, draft) {
  const confirmedResume = id => { const entry = versionEntry(state, id); return entry?.material.kind === 'resume' && entry.version.confirmed; };
  return { language: 'zh', questionCount: 5, mode: 'realtime', ...draft,
    versionId: confirmedResume(selectedVersion) ? selectedVersion : confirmedResume(draft?.versionId) ? draft.versionId : '' };
}

export function InterviewForm({ state, goal, t, busy, onClose, onStart, selectedVersion = '', draft, onDraftChange, saving = false }) {
  const [form, update] = useFormDraft(interviewFormDraft(state, selectedVersion), draft, onDraftChange);
  const { versionId, language, questionCount, mode } = interviewFormDraft(state, form.versionId, form);
  const hasJob = goalHasJob(state, goal);
  return <Modal title={t('newInterview')} t={t} onClose={onClose} busy={saving}><p className="zj-subtle">{t('interviewIntro')}</p>
    <form className="zj-form" onSubmit={event => { event.preventDefault(); if (!busy && hasJob && versionId) void onStart({ goalId: goal.id, versionId, language, questionCount, mode }); }}>
      <label>{t('interviewMode')}<select disabled={saving} value={mode} onChange={e => update({ mode: e.target.value })}><option value="realtime">{t('realtimeCall')}</option><option value="text">{t('textInterview')}</option></select></label>
      <ResumeSelect state={state} value={versionId} onChange={versionId => { if (!saving) update({ versionId }); }} t={t}/><div className="zj-inline-fields">
        <label>{t('language')}<select disabled={saving} value={language} onChange={e => update({ language: e.target.value })}><option value="zh">{t('zhLanguage')}</option><option value="en">{t('enLanguage')}</option></select></label>
        <label>{t('questions')}<input disabled={saving} type="number" min={1} max={10} required value={questionCount} onChange={e => update({ questionCount: Number(e.target.value) })}/></label>
      </div>{!hasJob && <p className="zj-error">{t('jobRequired')}</p>}<FormFooter t={t} busy={busy} saving={saving} disabled={!hasJob || !versionId} onClose={onClose} submit="start"/>
    </form>
  </Modal>;
}

export function Interview({ state, interview, t, busy, onAction, onExport, voiceApi, realtimeApi, openRealtimeSettings, onChanged, nativeChat, onEvidence, answerDraft, onAnswerDraftChange }) {
  const [localDraft, setLocalDraft] = React.useState(null);
  const current = interview.questions.find(row => row.id === interview.currentQuestionId);
  const draft = answerDraft || localDraft;
  const answer = current && draft?.questionId === current.id ? draft.text : '';
  const speechDraft = current && draft?.questionId === current.id ? draft.speechDraft : null;
  const updateAnswer = (text, speech = speechDraft) => {
    const next = { questionId: current?.id, text, speechDraft: speech };
    setLocalDraft(next); onAnswerDraftChange?.(next);
  };
  const report = state.reports.find(row => row.id === interview.reportId);
  const submit = async event => {
    event.preventDefault();
    if (busy || interview.status !== 'active' || !current || current.answer || !answer.trim()) return;
    const result = await onAction('interview.answer', { interviewId: interview.id, questionId: current?.id, questionNumber: interview.questions.findIndex(row => row.id === current?.id) + 1, text: answer,
      ...(speechDraft?.questionId === current?.id ? { speechDraftId: speechDraft.speechDraftId, editedTranscript: speechDraft.editedTranscript } : {}) });
    if (result) { setLocalDraft(null); onAnswerDraftChange?.(undefined); }
  };
  if (interview.mode === 'realtime' && interview.status !== 'completed') return <RealtimeInterview interview={interview} t={t} busy={busy} onAction={onAction} api={realtimeApi} openSettings={openRealtimeSettings} onChanged={onChanged}/>;
  return <div className="zj-interview-layout"><div className="zj-interview-work">
    <span className="zj-eyebrow">{t('interview')}</span>
    <p className="zj-subtle">{t('interviewNativeHint')}</p>
    {interview.status === 'completed' ? <><h2>{t('report')}</h2>{report ? <><Evaluation result={report} t={t} onEvidence={onEvidence}/>{[['strengths',report.strengths],['improvements',report.improvements],['nextSteps',report.nextSteps]].map(([key, values]) => <section className="zj-card" key={key}><h3>{t(key)}</h3><Lines values={values}/></section>)}<div className="zj-actions"><Button onClick={() => onExport('report', report.id, 'docx')}>{t('exportDocx')}</Button><Button onClick={() => onExport('report', report.id, 'pdf')}>{t('exportPdf')}</Button></div></> : <p>{t('noReport')}</p>}</> : <>
      {interview.status === 'paused' && <p className="zj-status-line">{t('paused')}</p>}
      {current && <><p className="zj-subtle">{t('question', { number: interview.questions.indexOf(current) + 1 })}{current.kind === 'followup' ? ` · ${t('followup')}` : ''}</p><h2 className="zj-question">{current.text}</h2></>}
      {interview.lastError && <p className="zj-error">{t('errorTitle')}</p>}
      <form className="zj-form" onSubmit={submit}><label>{t('answer')}<textarea required rows={8} value={answer} placeholder={t('answerPlaceholder')} disabled={busy || interview.status !== 'active' || Boolean(current?.answer)} onChange={e => updateAnswer(e.target.value)}/></label>
        <div className="zj-actions"><Button type="submit" primary disabled={busy || interview.status !== 'active' || !answer.trim() || Boolean(current?.answer)}>{t('submitAnswer')}</Button>
          <Button disabled={busy} onClick={() => onAction(`interview.${interview.status === 'paused' ? 'resume' : 'pause'}`, { interviewId: interview.id })}>{t(interview.status === 'paused' ? 'resumeInterview' : 'pause')}</Button>
        </div>
      </form><VoiceAnswer key={`${interview.id}:${current?.id || ''}`} api={voiceApi} language={interview.language} t={t} interviewId={interview.id} questionId={current?.id} question={current?.text || ''}
        onDraft={(text, draft) => { if (draft.questionId === current?.id) updateAnswer(text, draft); }} disabled={busy || interview.status !== 'active' || !current || Boolean(current.answer)}/>
      <Button quiet disabled={busy} onClick={() => onAction('interview.finish', { interviewId: interview.id })}>{t('finish')}</Button>
    </>}
    {interview.questions.filter(row => row.answer).map((row, index) => {
      const draft = row.speechDrafts?.find(item => item.id === row.answer.speechDraftId);
      const review = draft?.reviews?.find(item => item.id === row.answer.speechReviewId);
      return <details className="zj-answer-history" key={row.id}><summary>{t('question', { number: index + 1 })} · {row.text}</summary><p>{row.answer.text}</p>
        {draft && review && <details><summary>{t('voiceEvidence')}</summary><h4>{t('voiceOriginalTranscript')}</h4><p>{draft.rawTranscript}</p><h4>{t('voiceEditedTranscript')}</h4><p>{review.editedTranscript}</p></details>}
      </details>;
    })}
  </div>{nativeChat}</div>;
}

function RealtimeInterview({ interview, t, busy, onAction, api, openSettings, onChanged }) {
  const [revisions, setRevisions] = React.useState({});
  const callApi = React.useMemo(() => ({ realtime: api }), [api]);
  const answered = interview.questions.filter(question => question.answer);
  const answerText = answer => revisions[answer.id]?.baseHash === answer.hash ? revisions[answer.id].text : answer.text;
  const review = async () => {
    const edits = answered.filter(question => revisions[question.answer.id]?.baseHash === question.answer.hash)
      .map(question => ({ answerId: question.answer.id, text: revisions[question.answer.id].text }));
    const result = await onAction('realtime.review', { interviewId: interview.id, revisions: edits });
    if (result) await onAction('interview.finish', { interviewId: interview.id });
  };
  return <div className="zj-body zj-realtime-interview"><RealtimeCall interview={interview} api={callApi} t={t} onChanged={onChanged} openSettings={openSettings}/>
    {interview.unassignedTranscripts?.length > 0 && <details className="zj-answer-history"><summary>{t('realtimeUnassigned')}</summary><p className="zj-subtle">{t('realtimeUnassignedNote')}</p>{interview.unassignedTranscripts.map(row => <p key={row.eventId}>{row.text}</p>)}</details>}
    {interview.status === 'paused' && answered.length > 0 && <section className="zj-card"><h3>{t('realtimeReview')}</h3><p className="zj-subtle">{t('realtimeReviewNote')}</p>
      {answered.map(question => <details className="zj-answer-history" key={question.id}><summary>{question.text}</summary>
        {question.interrupted && <p className="zj-subtle">{t('realtimePartialQuestion')}</p>}
        <label>{t('answer')}<textarea rows={4} disabled={busy} value={answerText(question.answer)} onChange={event => setRevisions(current => ({ ...current, [question.answer.id]: { text: event.target.value, baseHash: question.answer.hash } }))}/></label>
        <details><summary>{t('voiceOriginalTranscript')}</summary><p>{question.answer.parts?.map(part => part.text).join('\n')}</p></details>
      </details>)}
      <Button primary disabled={busy || answered.some(question => !answerText(question.answer).trim())} onClick={review}>{t('realtimeConfirmReport')}</Button>
    </section>}
  </div>;
}
