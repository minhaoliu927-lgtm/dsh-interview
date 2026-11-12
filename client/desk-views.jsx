import React from 'react';
import { Button, Evaluation, Lines, Tabs } from './components.jsx';
import { RewriteResult } from './analysis.jsx';
import { filterCollection, PAGE_LABELS, objectKey } from './desk-collections.js';

export function Collection({ page, rows, value = {}, onChange, onOpen, onCreate, onAddMaterial, onStatusChange, busy, t }) {
  const visible = filterCollection(rows, value), ref = React.useRef(null);
  React.useLayoutEffect(() => { if (ref.current) ref.current.scrollTop = value.scroll || 0; }, [page]);
  const categories = [...new Set(rows.map(row => row.category))];
  return <div className="zj-body zj-collection" ref={ref} onScroll={event => onChange({ scroll: event.currentTarget.scrollTop })} data-collection={page}>
    <div className="zj-page-heading"><div><span className="zj-eyebrow">{t('panel')}</span><h2>{t(PAGE_LABELS[page])}</h2><p>{t(`deskIntro_${page}`)}</p></div>{onCreate && <Button primary onClick={onCreate}>{t(page === 'personal' ? 'addMaterial' : page === 'goals' ? 'newGoal' : 'newChat')}</Button>}</div>
    <div className="zj-collection-tools"><label className="zj-search">{t('deskSearch')}<input type="search" placeholder={t('deskSearchHint')} value={value.query || ''} onChange={e => onChange({ query: e.target.value, scroll: 0 })}/></label>
      <label>{t('deskFilter')}<select value={value.filter || 'all'} onChange={e => onChange({ filter: e.target.value, scroll: 0 })}><option value="all">{t('deskAll')}</option>{categories.map(kind => <option key={kind} value={kind}>{t(kind === 'company' ? 'companyMaterial' : kind)}</option>)}</select></label>
      <label>{t('deskSort')}<select value={value.sort || 'newest'} onChange={e => onChange({ sort: e.target.value })}>{['newest', 'oldest', 'title'].map(sort => <option key={sort} value={sort}>{t(`deskSort_${sort}`)}</option>)}</select></label>
      <div className="zj-layout-toggle" role="group" aria-label={t('deskLayout')}>{['cards', 'list', ...(page === 'goals' ? ['board'] : [])].map(layout => <Button key={layout} small aria-pressed={(value.layout || 'cards') === layout} onClick={() => onChange({ layout })}>{t(`deskLayout_${layout}`)}</Button>)}</div>
    </div><p className="zj-subtle" role="status">{t('deskCount', { shown: visible.length, total: rows.length })}</p>
    {page === 'reports' && <ReportTrend rows={visible.filter(row => row.kind === 'report')} t={t}/>}
    {visible.length ? page === 'goals' && value.layout === 'board' ? <div className="zj-role-board">{['active', 'archived'].map(status => <section className="zj-board-column" data-goal-status={status} key={status} onDragOver={event => { if (!busy && Array.from(event.dataTransfer.types).includes('application/x-zhijing-goal')) event.preventDefault(); }} onDrop={event => {
      event.preventDefault(); if (busy) return; const row = rows.find(row => row.id === event.dataTransfer.getData('application/x-zhijing-goal'));
      if (row && row.status !== status) onStatusChange?.(row.id, status);
    }}><h3>{t(status)} <span>{visible.filter(row => row.status === status).length}</span></h3>{visible.filter(row => row.status === status).map(row => <article className="zj-board-card" key={row.id} draggable={!busy} onDragStart={event => { event.dataTransfer.setData('application/x-zhijing-goal', row.id); event.dataTransfer.effectAllowed = 'move'; }}><button type="button" data-object-key={objectKey(row)} onClick={() => onOpen(row)}><strong>{row.title}</strong><p>{row.description}</p></button><Button small quiet disabled={busy} onClick={() => onStatusChange?.(row.id, status === 'active' ? 'archived' : 'active')}>{t(status === 'active' ? 'deskArchive' : 'deskRestore')}</Button></article>)}</section>)}</div> : <div className={`zj-object-grid ${value.layout === 'list' ? 'is-list' : ''}`}>{visible.map(row => <button className="zj-object-card" data-object-key={objectKey(row)} key={objectKey(row)} onClick={() => onOpen(row)}><span className="zj-eyebrow">{t(row.category === 'company' ? 'companyMaterial' : row.category)}</span><strong>{row.title || t(PAGE_LABELS[page])}</strong><p>{row.description}</p><span className="zj-object-meta">{row.count !== undefined ? t(page === 'personal' ? 'deskVersions' : page === 'interviews' ? 'deskAnswers' : 'deskConversations', { count: row.count }) : typeof row.total === 'number' ? `${row.total} / 100` : ''}<time dateTime={row.createdAt}>{row.createdAt?.slice(0, 10)}</time></span></button>)}</div>
      : <div className="zj-empty"><h2>{t(rows.length ? 'deskNoMatches' : page === 'home' ? 'homeTitle' : 'deskEmpty')}</h2><p>{t(rows.length ? 'deskNoMatchesNote' : `deskIntro_${page}`)}</p>{!rows.length && onCreate && <div className="zj-actions"><Button primary onClick={onCreate}>{t(page === 'home' ? 'newChat' : page === 'personal' ? 'addMaterial' : 'newGoal')}</Button>{page === 'home' && onAddMaterial && <Button onClick={onAddMaterial}>{t('addMaterial')}</Button>}</div>}{rows.length > 0 && <Button onClick={() => onChange({ query: '', filter: 'all', scroll: 0 })}>{t('deskClearFilters')}</Button>}</div>}
  </div>;
}

function ReportTrend({ rows, t }) {
  const values = rows.filter(row => Number.isFinite(row.total)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!values.length) return null;
  const recent = values.slice(-12), points = recent.map((row, index) => `${20 + index * 260 / Math.max(1, recent.length - 1)},${108 - row.total * .88}`).join(' ');
  return <section className="zj-report-trend" aria-label={t('deskReportTrend')}><div><span className="zj-subtle">{t('deskReportTrend')}</span><strong>{recent.at(-1).total}<small> / 100</small></strong><p>{t('deskTrendNote')}</p></div><svg viewBox="0 0 300 130" role="img" aria-label={recent.map(row => `${row.createdAt.slice(0, 10)}: ${row.total}`).join('; ')}><path d="M20 20V108H280" fill="none" stroke="currentColor" opacity=".2"/><polyline points={points} fill="none" stroke="var(--zj-accent)" strokeWidth="2"/>{recent.map((row, index) => <circle key={row.id} cx={20 + index * 260 / Math.max(1, recent.length - 1)} cy={108 - row.total * .88} r="3" fill="var(--zj-accent)"><title>{row.createdAt.slice(0, 10)}: {row.total}</title></circle>)}</svg></section>;
}

export function StudioHeader({ t, title, onBack, previous, next, onMove, focus, onFocus }) {
  return <header className="zj-studio-head" data-studio-header=""><Button small quiet onClick={onBack}>{t('deskBack')}</Button><strong>{title}</strong><div className="zj-actions"><Button small quiet disabled={!previous} onClick={() => onMove(previous)} aria-label={t('deskPrevious')}>‹</Button><Button small quiet disabled={!next} onClick={() => onMove(next)} aria-label={t('deskNext')}>›</Button><Button small quiet aria-pressed={focus} onClick={onFocus}>{t(focus ? 'deskSplit' : 'deskFocus')}</Button></div></header>;
}

export function CopyText({ text, t }) {
  const [status, setStatus] = React.useState(null);
  React.useEffect(() => setStatus(null), [text]);
  return <span className="zj-copy"><Button small disabled={!text} onClick={async () => { try { await navigator.clipboard.writeText(text); setStatus('deskCopied'); } catch { setStatus('deskCopyFailed'); } }}>{t('deskCopy')}</Button>{status && <span role="status" className="zj-subtle">{t(status)}</span>}</span>;
}

export function ResultStudio({ row, state, t, busy, onExport, onEvidence, onAction, onReviewVersion, draft, onDraftChange }) {
  const [tab, setTab] = React.useState('deskResult');
  const value = row?.entity;
  if (!value) return <div className="zj-body"><p>{t('unavailable')}</p></div>;
  const resume = state.materials.flatMap(material => material.versions).find(version => version.id === value.versionId);
  const body = row.kind === 'rewrite' ? value.fullText : [value.summary, ...(value.criteria || []).map(item => `${item.label || item.name || item.id}: ${item.reason || ''}`), ...(value.strengths || []), ...(value.improvements || []), ...(value.nextSteps || [])].filter(Boolean).join('\n\n');
  return <div className="zj-body zj-result-studio"><div className="zj-page-heading"><div><span className="zj-eyebrow">{t(row.category)}</span><h2>{row.title || t('deskReports')}</h2><time className="zj-subtle" dateTime={row.createdAt}>{row.createdAt?.slice(0, 10)}</time></div><CopyText text={body} t={t}/></div>
    <Tabs values={['deskResult', 'deskSources']} active={tab} onChange={setTab} t={t}/>
    {tab === 'deskSources' ? <section className="zj-card"><h3>{t('chatSnapshot')}</h3>{resume ? <><p>{resume.title} · {t('version', { number: resume.revision })}</p><Button small onClick={() => onReviewVersion(resume.id)}>{t('viewSource')}</Button><div className="zj-paper-content">{resume.text}</div></> : <p>{t('unavailable')}</p>}</section> : row.kind === 'rewrite' ? <RewriteResult rewrite={value} state={state} selectedVersion={value.versionId} t={t} busy={busy} onAccept={(rewriteId, itemIds) => onAction('rewrite.accept', { rewriteId, itemIds })} onExport={onExport} onReviewVersion={onReviewVersion} onEvidence={onEvidence} draft={draft} onDraftChange={onDraftChange}/>
      : <><Evaluation result={value} t={t} onEvidence={onEvidence}/>{row.kind === 'report' && <>{[['strengths', value.strengths], ['improvements', value.improvements], ['nextSteps', value.nextSteps]].map(([key, values]) => <section className="zj-card" key={key}><h3>{t(key)}</h3><Lines values={values}/></section>)}<div className="zj-actions"><Button disabled={busy} onClick={() => onExport('report', value.id, 'docx')}>{t('exportDocx')}</Button><Button disabled={busy} onClick={() => onExport('report', value.id, 'pdf')}>{t('exportPdf')}</Button></div></>}</>}
  </div>;
}
