import React from 'react';
import { Button, Evaluation, EvidenceList, createSubmissionGuard } from './components.jsx';
import { goalHasJob, latestAssessment, resumeOptions, versionEntry } from './model.js';

export function ResumeSelect({ state, value, onChange, t }) {
  const options = resumeOptions(state), current = versionEntry(state, value);
  if (current?.material.kind === 'resume' && !options.some(row => row.version.id === value)) options.push(current);
  return <label>{t('selectResume')}<select required value={current?.material.kind === 'resume' ? value : ''} onChange={e => onChange(e.target.value)}><option value="">{t('selectPlaceholder')}</option>{options.map(({ material, version }) => <option key={version.id} value={version.id}>{material.title} · {t('version', { number: version.revision })}{!version.confirmed && ` · ${t('unconfirmed')}`}</option>)}</select></label>;
}

/** DOM textarea offsets use LF; map them back to the exact immutable original. */
export function selectedResumePassage(version, selection) {
  if (!version || typeof version.text !== 'string' || selection?.versionId !== version.id
    || selection.value !== version.text.replace(/\r\n?/g, '\n')
    || !Number.isInteger(selection.start) || !Number.isInteger(selection.end) || selection.start < 0 || selection.end <= selection.start) return null;
  const offsets = [0];
  for (let index = 0; index < version.text.length;) {
    index += version.text[index] === '\r' && version.text[index + 1] === '\n' ? 2 : 1;
    offsets.push(index);
  }
  if (selection.end >= offsets.length) return null;
  const start = offsets[selection.start], end = offsets[selection.end], text = version.text.slice(start, end);
  return text.trim() ? { versionId: version.id, start, end, text } : null;
}

export function rewriteForVersion(state, goalId, versionId) {
  return state.rewrites.find(row => row.goalId === goalId && row.versionId === versionId)
    || state.rewrites.find(row => row.goalId === goalId && (row.acceptedVersionId === versionId || row.acceptances?.some(value => value.versionId === versionId)));
}

export function selectedRewriteItems(rewrite, draft, selectedVersion) {
  const accepted = rewrite.acceptances?.find(value => value.versionId === selectedVersion);
  const ids = Array.isArray(draft?.selectedIds) ? draft.selectedIds : accepted?.itemIds ?? rewrite.items.map(item => item.id);
  return [...new Set(ids)].filter(id => rewrite.items.some(item => item.id === id));
}

export function savedRewriteVersion(rewrite, result) {
  const version = result?.version;
  return result?.rewriteId === rewrite.id && typeof version?.id === 'string' && version.id !== rewrite.versionId
    && version.materialId === rewrite.materialId && Number.isSafeInteger(version.revision) && version.revision > 0
    ? { id: version.id, revision: version.revision, materialId: version.materialId } : null;
}

export function RewriteResult({ rewrite, state, selectedVersion, onSelectVersion, onReviewVersion, t, busy, onAccept, onExport, onEvidence, draft, onDraftChange }) {
  const [local, setLocal] = React.useState({}), [saving, setSaving] = React.useState(false);
  const value = draft ?? local, selected = selectedRewriteItems(rewrite, value, selectedVersion);
  const currentDraft = React.useRef(value); currentDraft.current = value;
  const guard = React.useRef(createSubmissionGuard());
  const update = patch => { const next = { ...currentDraft.current, ...patch }; currentDraft.current = next; setLocal(next); onDraftChange?.(next); };
  const acceptedId = value.savedVersion?.id ?? rewrite.acceptedVersionId;
  const acceptedEntry = versionEntry(state, acceptedId);
  const saved = acceptedEntry?.material.id === rewrite.materialId ? acceptedEntry.version
    : value.savedVersion?.materialId === rewrite.materialId ? value.savedVersion : null;
  const source = versionEntry(state, rewrite.versionId);
  const reviewVersion = onReviewVersion ?? onSelectVersion;
  const accept = () => guard.current(async () => {
    if (busy || !selected.length) return;
    setSaving(true);
    try {
      const result = await onAccept(rewrite.id, [...selected]);
      const actual = savedRewriteVersion(rewrite, result);
      if (actual) update({ savedVersion: actual });
    } finally { setSaving(false); }
  });
  return <section className="zj-card"><h3>{t('selectChanges')}</h3>{rewrite.items.map(item => <article className="zj-diff" key={item.id}>
    <label><input type="checkbox" disabled={busy || saving} checked={selected.includes(item.id)} onChange={event => {
      const current = selectedRewriteItems(rewrite, currentDraft.current, selectedVersion);
      update({ selectedIds: event.target.checked ? [...new Set([...current, item.id])] : current.filter(id => id !== item.id) });
    }}/>{item.reason}</label>
    <div className="zj-diff-grid"><div><span className="zj-subtle">{t('original')}</span><pre>{item.before}</pre></div><div><span className="zj-subtle">{t('revised')}</span><pre className="after">{item.after}</pre></div></div>{onEvidence && <EvidenceList values={item.evidence || []} onEvidence={onEvidence} t={t}/>}
  </article>)}
    {source && <p className="zj-subtle">{t('rewriteSourceVersion', { version: t('version', { number: source.version.revision }) })}</p>}
    {saved && <div className="zj-review-note"><p className="zj-status-line" role="status">{t('rewriteSavedVersion', { version: t('version', { number: saved.revision }) })} {t('accepted')}</p>
      <div className="zj-actions"><Button small disabled={busy || saving || (!onReviewVersion && selectedVersion === saved.id) || !reviewVersion} onClick={() => reviewVersion(saved.id)}>{t('rewriteViewNewVersion')}</Button>
        <Button small disabled={busy || saving || selectedVersion === rewrite.versionId || !source || !onSelectVersion} onClick={() => onSelectVersion(rewrite.versionId)}>{t('rewriteReturnOriginalVersion')}</Button></div><p className="zj-subtle">{t('rewriteVersionSwitchNote')}</p></div>}
    <Button primary disabled={busy || saving || !selected.length} onClick={() => { void accept(); }}>{t('acceptChanges')}</Button>
    <details className="zj-card"><summary>{t('fullResume')}</summary><div className="zj-paper-content">{rewrite.fullText}</div></details>
    {saved && onExport && <div className="zj-actions"><Button small onClick={() => onExport('resume', saved.id, 'docx')}>{t('exportDocx')}</Button><Button small onClick={() => onExport('resume', saved.id, 'pdf')}>{t('exportPdf')}</Button></div>}
  </section>;
}

export function Analysis({ state, goal, tab, t, busy, onAction, onExport, selectedVersion, onSelectVersion, onReviewVersion, onEvidence, draft, onDraftChange, onChatContext }) {
  const scope = `${goal.id}:${selectedVersion || ''}:${tab}`;
  const [localDrafts, setLocalDrafts] = React.useState({}), [selection, setSelection] = React.useState(null), [selectionNotice, setSelectionNotice] = React.useState(null);
  const value = draft ?? localDrafts[scope] ?? {}, instructions = value.instructions ?? '';
  const currentDraft = React.useRef({ scope, value }); currentDraft.current = { scope, value };
  const instructionRef = React.useRef(null), sourceId = React.useId(), sourceHelpId = React.useId();
  const submitGuard = React.useRef(createSubmissionGuard());
  const update = patch => {
    const previous = currentDraft.current.scope === scope ? currentDraft.current.value : value;
    const next = { ...previous, ...patch };
    if (currentDraft.current.scope === scope) currentDraft.current = { scope, value: next };
    setLocalDrafts(values => ({ ...values, [scope]: next })); onDraftChange?.(next);
  };
  const kind = tab === 'fit' ? 'fit' : 'resume';
  const hasJob = goalHasJob(state, goal);
  const entry = versionEntry(state, selectedVersion), source = entry?.material.kind === 'resume' ? entry : null;
  const canGenerate = Boolean(source?.version.confirmed) && !busy && instructions.length <= 10_000 && (tab !== 'fit' || hasJob);
  const rewrite = rewriteForVersion(state, goal.id, selectedVersion);
  const result = latestAssessment(state, selectedVersion, goal.id, kind);
  const passage = selectedResumePassage(source?.version, selection);
  const quoted = passage ? t('rewriteSelectionPrompt', { version: t('version', { number: source.version.revision }), passage: passage.text }) : '';
  const nextInstructions = `${instructions}${instructions ? '\n\n' : ''}${quoted}`;
  const selectionTooLong = Boolean(passage) && nextInstructions.length > 10_000;
  const rememberSelection = event => setSelection({ versionId: selectedVersion, value: event.currentTarget.value,
    start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd });
  const useSelection = () => {
    if (!passage || selectionTooLong || busy) return;
    update({ instructions: nextInstructions }); setSelectionNotice({ scope, key: 'rewriteSelectionAdded' }); instructionRef.current?.focus();
  };
  return <><form className="zj-form" onSubmit={event => {
    event.preventDefault();
    if (!canGenerate) return;
    void submitGuard.current(() => onAction(tab === 'rewrite' ? 'rewrite.run' : 'assessment.run', tab === 'rewrite'
      ? { versionId: selectedVersion, goalId: goal.id, instructions }
      : { versionId: selectedVersion, goalId: goal.id, kind }));
  }}>
    <ResumeSelect state={state} value={selectedVersion} onChange={onSelectVersion} t={t}/>
    {source ? <p className="zj-subtle">{t('analysisContext', { goal: goal.title, material: source.material.title, version: t('version', { number: source.version.revision }) })}</p> : <p className="zj-subtle">{t('resumeRequired')}</p>}
    {source && onChatContext && <div><Button small disabled={busy || !source.version.confirmed} onClick={() => onChatContext(source.version.id)}>{t('askAboutMaterial')}</Button></div>}
    {source && !source.version.confirmed && <p className="zj-review-note">{t('unconfirmed')} · {t('reviewNote')}</p>}
    {tab === 'rewrite' ? <>
      {typeof source?.version.text === 'string' && <details className="zj-card"><summary>{t('rewriteSource')}</summary>
        <label htmlFor={sourceId}>{t('rewriteSourceVersion', { version: t('version', { number: source.version.revision }) })}</label>
        <p className="zj-subtle" id={sourceHelpId}>{t('rewriteSourceHelp')}</p>
        <textarea id={sourceId} readOnly rows={8} aria-describedby={sourceHelpId} value={source.version.text.replace(/\r\n?/g, '\n')}
          onSelect={rememberSelection} onKeyUp={rememberSelection} onMouseUp={rememberSelection}/>
        <Button small disabled={busy || !passage || selectionTooLong} onClick={useSelection}>{t('rewriteUseSelection')}</Button>
        {onChatContext && <Button small disabled={busy || !source.version.confirmed || !passage} onClick={() => passage && onChatContext(source.version.id, passage)}>{t('askAboutPassage')}</Button>}
        {selectionTooLong && <p className="zj-error" role="status">{t('rewriteSelectionTooLong')}</p>}
      </details>}
      <label>{t('rewriteInstructions')}<textarea ref={instructionRef} rows={3} maxLength={10000} disabled={busy} value={instructions} placeholder={t('rewritePlaceholder')} onChange={e => update({ instructions: e.target.value })}/></label>
      {selectionNotice?.scope === scope && <p className="zj-status-line" role="status">{t(selectionNotice.key)}</p>}
    </> : <p className="zj-subtle">{t('assessNote')}</p>}
    {tab === 'fit' && !hasJob && <p className="zj-subtle">{t('jobRequired')}</p>}
    <div><Button type="submit" primary disabled={!canGenerate}>{t(tab === 'rewrite' ? 'generateRewrite' : tab === 'fit' ? 'assessFit' : 'assessResume')}</Button></div>
  </form>
    {tab === 'rewrite' ? rewrite && <RewriteResult key={`${rewrite.id}:${scope}`} rewrite={rewrite} state={state} selectedVersion={selectedVersion} onSelectVersion={onSelectVersion} onReviewVersion={onReviewVersion}
      draft={value.rewrites?.[rewrite.id]} onDraftChange={next => update({ rewrites: { ...(currentDraft.current.scope === scope ? currentDraft.current.value : value).rewrites, [rewrite.id]: next } })}
      t={t} busy={busy} onAccept={(rewriteId, itemIds) => onAction('rewrite.accept', { rewriteId, itemIds })} onExport={onExport} onEvidence={onEvidence}/> : <Evaluation result={result} t={t} onEvidence={onEvidence}/>}
  </>;
}
