import React from 'react';
import css from './styles.css';
import deskCss from './desk-styles.css';
import { Button, GoalForm, Mark, MaterialForm, MaterialPicker, Modal, Tabs, TaskCancelContext, createSubmissionGuard } from './components.jsx';
import { Materials, GoalMaterials } from './materials.jsx';
import { Analysis, ResumeSelect } from './analysis.jsx';
import { Interview, InterviewForm, interviewFormDraft } from './interview.jsx';
import { NativeChat } from './native-chat.jsx';
import { citationSource, quoteSegments, versionEntry } from './model.js';
import { SourceDialog } from './source.jsx';
import { VoiceSetup } from './voice-ui.jsx';
import { TaskCard, ReceiptList } from './task-card.jsx';
import { materialChatContext, contextDraft } from './desk-context.js';
import { Collection, StudioHeader, ResultStudio } from './desk-views.jsx';
import { DESK_PAGES, PAGE_LABELS, collectionRows, filterCollection, objectKey } from './desk-collections.js';

export function initialWorkbenchNavigation() {
  return { view: 'home', goalId: null, sessionId: null, byGoal: {}, drafts: {} };
}

// Navigation and unfinished input are scoped to this mounted workbench, never to
// browser storage or another user. Session history remains owned by DSH.
export function workbenchNavigation(state, event) {
  if (event.type === 'openObject') {
    const key = objectKey(event.target);
    const byObject = { ...state.byObject };
    if (state.studio) byObject[objectKey(state.studio.target)] = state.sessionId;
    return { ...state, view: event.view, goalId: event.goalId || null,
      sessionId: event.sessionId || byObject[key] || null, byObject,
      studio: { target: event.target, origin: state.studio?.origin || { view: state.view, goalId: state.goalId, sessionId: state.sessionId }, page: state.studio?.page || event.page || 'home' } };
  }
  if (event.type === 'closeObject') {
    if (!state.studio) return state;
    return { ...state, ...state.studio.origin, byObject: { ...state.byObject, [objectKey(state.studio.target)]: state.sessionId }, studio: null };
  }
  if (event.type === 'deskPage') {
    const prior = state.studio ? workbenchNavigation(state, { type: 'closeObject' }) : state;
    return { ...prior, view: event.view, studio: null, goalId: null };
  }
  if (event.type === 'draft') {
    const drafts = { ...state.drafts };
    if (event.value === undefined) delete drafts[event.key]; else drafts[event.key] = event.value;
    return { ...state, drafts };
  }
  if (event.type === 'view') return { ...state, view: event.view,
    ...(event.view === 'home' ? { goalId: null } : {}) };
  if (event.type === 'workspace') return { ...state, view: state.returnView || (state.goalId ? 'goal' : 'home') };
  if (event.type === 'deskChat') return { ...state, sessionId: event.sessionId,
    byGoal: state.goalId ? { ...state.byGoal, [state.goalId]: { ...state.byGoal[state.goalId], sessionId: event.sessionId } } : state.byGoal };
  if (event.type === 'goal') {
    const saved = state.byGoal[event.goalId];
    // Clicking the current goal from its chat opens the goal's own tabs. Coming
    // back from another section restores the last visited view and exact Session.
    const view = state.goalId === event.goalId && state.view === 'chat' ? 'goal' : saved?.view || 'goal';
    return { ...state, view, goalId: event.goalId, sessionId: saved?.sessionId || null,
      byGoal: { ...state.byGoal, [event.goalId]: { tab: 'overview', versionId: '', ...saved, view } } };
  }
  if (event.type === 'chat') {
    const goalId = event.goalId || null;
    return { ...state, view: 'chat', goalId, sessionId: event.sessionId,
      returnView: state.view !== 'chat' && state.goalId === goalId ? state.view : goalId ? 'goal' : 'home',
      byGoal: goalId ? { ...state.byGoal, [goalId]: { tab: 'overview', versionId: '', ...state.byGoal[goalId], view: 'chat', sessionId: event.sessionId } } : state.byGoal };
  }
  if ((event.type === 'tab' || event.type === 'version') && state.goalId) {
    return { ...state, byGoal: { ...state.byGoal, [state.goalId]: { ...state.byGoal[state.goalId],
      [event.type === 'tab' ? 'tab' : 'versionId']: event.value } } };
  }
  return state;
}

export function materialDraftKey(modal) {
  return modal?.material ? `material:${modal.material.id}:${modal.version?.id || ''}` : `material:new:${modal?.goalId || ''}:${modal?.initialKind || 'resume'}`;
}

export function App({ t, useCareer, useNativeSessions, useWorkspaceChoices, action, upload, refresh, cancelCurrent, retryCurrent, createConversation, startInterview, interviewAction, download,
  voiceApi, realtimeApi, prepareChatDraft, openRealtimeSettings, enableVoiceInput, openVoiceSettings, openWorkspaceManager, readSource, loadOriginal, downloadOriginal, useResource, SessionProvider, renderSlot }) {
  const snapshot = useCareer(value => value);
  const state = snapshot.data;
  const [navigation, navigate] = React.useReducer(workbenchNavigation, undefined, initialWorkbenchNavigation);
  const { view, goalId, sessionId, drafts, studio } = navigation;
  const [collections, setCollections] = React.useState({});
  const [focusResult, setFocusResult] = React.useState(false);
  const [chatExpanded, setChatExpanded] = React.useState(false);
  const navigationRef = React.useRef(navigation); navigationRef.current = navigation;
  const [dockOpen, setDockOpen] = React.useState(true);
  const [narrow, setNarrow] = React.useState(false);
  const [context, setContext] = React.useState(null);
  const [contextNotice, setContextNotice] = React.useState(null);
  const rootRef = React.useRef(null);
  const returnFocus = React.useRef(null);
  React.useLayoutEffect(() => {
    if (!studio && returnFocus.current) {
      const button = [...(rootRef.current?.querySelectorAll('[data-object-key]') || [])].find(node => node.dataset.objectKey === returnFocus.current);
      button?.focus({ preventScroll: true }); returnFocus.current = null;
    }
  }, [studio]);
  React.useEffect(() => {
    if (!rootRef.current || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 1180));
    observer.observe(rootRef.current); return () => observer.disconnect();
  }, []);
  React.useEffect(() => { if (narrow) setDockOpen(false); }, [narrow]);
  React.useEffect(() => { setContext(value => value?.sessionId === sessionId ? value : null); setContextNotice(null); }, [sessionId]);
  const selectedGoal = navigation.byGoal[goalId];
  const selectedResume = versionEntry(state, selectedGoal?.versionId);
  const versionId = selectedResume?.material.kind === 'resume' && selectedResume.version.confirmed ? selectedResume.version.id : '';
  const tab = selectedGoal?.tab || 'overview';
  const setVersionId = value => navigate({ type: 'version', value });
  const setTab = value => navigate({ type: 'tab', value });
  const setView = view => navigate({ type: 'view', view });
  const saveDraft = (key, value) => navigate({ type: 'draft', key, value });
  const [materialId, setMaterialId] = React.useState(null);
  const [materialVersionId, setMaterialVersionId] = React.useState(null);
  const [modal, setModal] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [localPending, setLocalPending] = React.useState(0);
  const [pendingLink, setPendingLink] = React.useState(null);
  const submissionGuard = React.useRef(null);
  if (!submissionGuard.current) submissionGuard.current = createSubmissionGuard();
  const currentModal = React.useRef(modal);
  currentModal.current = modal;
  const nativeSessions = useNativeSessions(value => value);
  const workspaceChoices = useWorkspaceChoices(value => value);
  const [workspaceId, setWorkspaceId] = React.useState('');
  const workspaceAnchor = React.useRef(null);
  const mainSessions = nativeSessions.ids.filter(id => nativeSessions.byId[id]?.retainedBy?.mainView > 0);
  const inheritedWorkspace = mainSessions.length === 1 ? workspaceChoices.items.find(row => row.sessionIds.includes(mainSessions[0])) : undefined;
  const selectedWorkspace = workspaceChoices.items.find(row => row.workspaceId === workspaceId) || (!workspaceId ? inheritedWorkspace : undefined);
  const sessionWorkspace = workspaceChoices.items.find(row => row.sessionIds.includes(sessionId));
  const nativeRunning = Boolean(nativeSessions.byId[sessionId]?.running);
  const goal = state.goals.find(row => row.id === goalId);
  const conversations = state.conversations || state.goals.flatMap(row => row.conversations);
  const conversation = conversations.find(row => row.sessionId === sessionId);
  const conversationTitle = row => nativeSessions.byId[row.sessionId]?.title || row.title;
  const interview = state.interviews.find(row => row.sessionId === sessionId);
  const busy = localPending > 0 || snapshot.pending > 0 || nativeRunning;
  const currentError = error || snapshot.error;
  const errors = new Set(['NATIVE_DRAFT_UNAVAILABLE','NATIVE_DRAFT_BLOCKED','CONTEXT_UNAVAILABLE','NETWORK','FILE_TOO_LARGE','JOB_MATERIAL_REQUIRED','INVALID_RESPONSE','REQUEST_FAILED','EXPORT_FAILED','WORKSPACE_REQUIRED']);

  const run = (operation, success) => submissionGuard.current(async () => {
    setError(null);
    setLocalPending(count => count + 1);
    try { const result = await operation(); success?.(result); return result; }
    catch (reason) { if (reason?.name !== 'AbortError' && !['CANCELLED', 'ABORT_ERR'].includes(reason?.code)) setError(reason); return undefined; }
    finally { setLocalPending(count => Math.max(0, count - 1)); }
  });
  const perform = (name, input) => run(() => action(name, input));
  const performInterview = (name, input) => run(() => interviewAction(name, input));
  const exportFile = (kind, id, format) => run(() => download(kind, id, format));
  const restoreWorkspace = id => {
    const workspace = workspaceChoices.items.find(row => row.sessionIds.includes(id));
    if (workspace) setWorkspaceId(workspace.workspaceId);
  };
  const selectGoal = id => openObject({ kind: 'goal', id }, 'goals');
  const selectChat = row => { restoreWorkspace(row.sessionId); navigate({ type: 'closeObject' }); navigate({ type: 'chat', goalId: row.goalId, sessionId: row.sessionId }); };
  const newChat = id => {
    if (!selectedWorkspace) { workspaceAnchor.current?.focus(); return; }
    const materialVersion = studio?.target.kind === 'material' ? versionEntry(state, materialVersionId || state.materials.find(row => row.id === studio.target.id)?.latestVersionId) : null;
    const artifactVersion = studio && collectionRows(state, 'reports').find(row => row.kind === studio.target.kind && row.id === studio.target.id)?.versionId;
    const selected = artifactVersion || (materialVersion?.version.confirmed ? materialVersion.version.id : id && versionEntry(state, versionId)?.version.confirmed ? versionId : undefined);
    return run(() => createConversation(id, t('untitledChat'), selected, selectedWorkspace.workspaceId, studio?.target), row => {
    setDockOpen(true);
    if (studio) navigate({ type: 'deskChat', sessionId: row.sessionId }); else selectChat({ ...row, goalId: id });
    });
  };
  const openInterview = () => {
    if (!selectedWorkspace) { workspaceAnchor.current?.focus(); return; }
    const key = `interview:${goalId}`;
    saveDraft(key, interviewFormDraft(state, versionId, drafts[key]));
    setModal({ kind: 'interview', goalId });
  };
  const addMaterial = (kind = 'resume', targetGoal = null) => setModal({ kind: 'material', initialKind: kind, goalId: targetGoal });
  const materialSaved = material => {
    if (modal?.goalId) setPendingLink({ materialId: material.id, goalId: modal.goalId });
    saveDraft(materialDraftKey(modal), undefined);
    if (currentModal.current === modal) { setModal(null); openObject({ kind: 'material', id: material.id, versionId: material.latestVersionId }, 'personal'); }
  };
  const confirmVersion = selectedVersionId => run(async () => {
    const result = await action('material.confirm', { versionId: selectedVersionId });
    if (pendingLink && result.materialId === pendingLink.materialId) await action('goal.linkMaterial', { goalId: pendingLink.goalId, versionId: selectedVersionId });
    return result;
  }, result => { if (pendingLink && result.materialId === pendingLink.materialId) { selectGoal(pendingLink.goalId); setPendingLink(null); } });
  const askContext = (id, passage) => {
    const selected = materialChatContext(state, id, passage);
    if (!selected) { setError({ code: 'CONTEXT_UNAVAILABLE' }); return; }
    if ((!sessionId || interview) && !selectedWorkspace) { workspaceAnchor.current?.focus(); setError({ code: 'WORKSPACE_REQUIRED' }); return; }
    const scope = navigationRef.current;
    return run(async () => {
      let target = interview ? null : sessionId;
      if (!target) {
        const row = await createConversation(goalId, t('untitledChat'), selected.kind === 'resume' || studio?.target.kind === 'material' ? id : undefined, selectedWorkspace.workspaceId, studio?.target);
        target = row.sessionId;
      }
      if (navigationRef.current !== scope) return;
      if (target !== sessionId) navigate({ type: 'deskChat', sessionId: target });
      setDockOpen(true); setContextNotice(null); setContext({ ...selected, sessionId: target });
    });
  };
  const addContextDraft = () => {
    const selected = context;
    if (!selected || selected.sessionId !== sessionId || interview) return;
    return run(async () => {
      if (!prepareChatDraft) throw Object.assign(new Error(t('unavailable')), { code: 'NATIVE_DRAFT_UNAVAILABLE' });
      await prepareChatDraft(selected.sessionId, contextDraft(selected, t));
      setContext(value => value === selected ? null : value);
      if (navigationRef.current.sessionId === selected.sessionId) setContextNotice(t('contextAdded'));
    });
  };
  const prepareSuggestion = key => {
    if (!selectedWorkspace && !sessionId) { workspaceAnchor.current?.focus(); setError({ code: 'WORKSPACE_REQUIRED' }); return; }
    const scope = navigationRef.current;
    return run(async () => {
      let target = sessionId;
      if (!target) {
        const candidate = studio?.target.kind === 'material' ? materialVersionId || state.materials.find(row => row.id === studio.target.id)?.latestVersionId : versionId;
        const entry = versionEntry(state, candidate);
        const artifactVersion = studio && collectionRows(state, 'reports').find(row => row.kind === studio.target.kind && row.id === studio.target.id)?.versionId;
        const row = await createConversation(goalId, t('untitledChat'), artifactVersion || (entry?.version.confirmed && (entry.material.kind === 'resume' || studio?.target.kind === 'material') ? candidate : undefined), selectedWorkspace.workspaceId, studio?.target);
        target = row.sessionId;
      }
      if (navigationRef.current !== scope) return;
      if (!prepareChatDraft) throw Object.assign(new Error(t('unavailable')), { code: 'NATIVE_DRAFT_UNAVAILABLE' });
      await prepareChatDraft(target, t(key));
      if (navigationRef.current !== scope) return;
      navigate({ type: 'deskChat', sessionId: target }); setDockOpen(true); setContextNotice(t('contextAdded'));
    });
  };
  const nativeChat = sessionId ? sessionWorkspace ? <NativeChat key={sessionId} sessionId={sessionId} t={t} useResource={useResource} SessionProvider={SessionProvider} renderSlot={renderSlot}/> : <div className="zj-body"><p className="zj-error">{workspaceChoices.phase === 'ready' ? t('floatingConversation') : t('loading')}</p></div> : null;
  const title = view === 'personal' ? t('personal') : (view === 'chat' && conversation && conversationTitle(conversation)) || goal?.title || t('panel');
  const showEvidence = citation => setModal({ kind: 'citation', citation });
  const source = modal?.kind === 'citation' ? citationSource(state, modal.citation.sourceId) : null;
  const segments = source ? quoteSegments(source.text, modal.citation) : null;
  const reviewVersion = selectedVersionId => {
    const entry = versionEntry(state, selectedVersionId);
    if (entry) openObject({ kind: 'material', id: entry.material.id, versionId: entry.version.id }, 'personal');
  };

  function openObject(target, page) {
    let nextView, nextGoal = target.goalId || null, nextSession = null;
    if (target.kind === 'material') { nextView = 'personal'; setMaterialId(target.id); setMaterialVersionId(target.versionId || null); }
    else if (target.kind === 'goal') { nextView = 'goal'; nextGoal = target.id; }
    else if (target.kind === 'interview' || target.kind === 'conversation') {
      const row = (target.kind === 'interview' ? state.interviews : conversations).find(row => row.id === target.id);
      if (!row) return;
      nextView = 'chat'; nextGoal = row.goalId; nextSession = row.sessionId;
    } else { nextView = 'result'; const row = collectionRows(state, 'reports').find(row => row.kind === target.kind && row.id === target.id); if (!row) return; nextGoal = row.goalId; }
    const stored = navigation.byObject?.[objectKey(target)] || state.deskConversations?.find(row => row.kind === target.kind && row.id === target.id)?.sessionId;
    if (!nextSession && stored) nextSession = stored;
    if (!nextSession && target.kind === 'goal') nextSession = conversations.find(row => row.goalId === nextGoal && row.kind === 'chat')?.sessionId || null;
    restoreWorkspace(nextSession || stored); setFocusResult(false); setChatExpanded(false); setDockOpen(!narrow);
    navigate({ type: 'openObject', target, page: page || (target.kind === 'material' ? 'personal' : target.kind === 'goal' ? 'goals' : ['report', 'assessment', 'rewrite'].includes(target.kind) ? 'reports' : target.kind === 'interview' ? 'interviews' : 'home'), view: nextView, goalId: nextGoal, sessionId: nextSession });
  }
  const selectPage = page => { setMaterialId(null); setFocusResult(false); setChatExpanded(false); navigate({ type: 'deskPage', view: page }); };
  const closeObject = () => { returnFocus.current = studio ? objectKey(studio.target) : null; setFocusResult(false); setChatExpanded(false); setMaterialId(null); navigate({ type: 'closeObject' }); };
  const selectedPage = studio?.page || (DESK_PAGES.includes(view) ? view : goalId ? 'goals' : 'home');
  const rows = collectionRows(state, selectedPage, nativeSessions.byId);
  const visibleRows = filterCollection(rows, collections[selectedPage]);
  const objectIndex = studio ? visibleRows.findIndex(row => objectKey(row) === objectKey(studio.target)) : -1;
  const resultRow = studio && collectionRows(state, 'reports').find(row => row.kind === studio.target.kind && row.id === studio.target.id);
  const objectTitle = studio?.target.kind === 'material' ? state.materials.find(row => row.id === studio.target.id)?.title : resultRow?.title || goal?.title || title;
  const undoReceipt = receipt => run(() => action('receipt.undo', { receiptId: receipt.id }));
  const newestUndo = (state.receipts || []).find(row => row.undo.available);
  React.useEffect(() => {
    const onKey = event => {
      if (!rootRef.current?.contains(event.target) || modal) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
      if (event.key === 'Escape' && context) { setContext(null); event.preventDefault(); }
      else if (event.key === 'Escape' && narrow && dockOpen) { setDockOpen(false); event.preventDefault(); }
      else if (event.key === 'Escape' && studio && !typing) { closeObject(); event.preventDefault(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey && !typing && newestUndo && !busy) { event.preventDefault(); void undoReceipt(newestUndo); }
    };
    const root = rootRef.current; root?.addEventListener('keydown', onKey); return () => root?.removeEventListener('keydown', onKey);
  }, [studio, context, narrow, dockOpen, modal, newestUndo?.id, busy]);

  const fullChat = (view === 'chat' && !interview && !studio) || chatExpanded;
  const showDock = fullChat || (dockOpen && !focusResult && !(view === 'chat' && interview?.mode === 'realtime'));
  return <TaskCancelContext.Provider value={{ canCancel: Boolean(snapshot.operation?.canCancel), cancel: () => cancelCurrent?.(snapshot.operation?.requestId) }}><div className={`zj${narrow ? ' zj-narrow' : ''}`} ref={rootRef} data-zhijing-workbench=""><style>{css + deskCss}</style><aside className="zj-rail" aria-label={t('panel')}>
    <div className="zj-brand"><Mark size={26}/><span>{t('panel')}</span></div>
    <section><h2 className="zj-section-label">{t('goals')}<button title={t('newGoal')} aria-label={t('newGoal')} onClick={() => setModal({ kind: 'goal' })}>+</button></h2>
      <div className="zj-goals">{state.goals.map(row => <div key={row.id}><button className={`zj-goal-name${goalId === row.id ? ' is-active' : ''}`} onClick={() => selectGoal(row.id)}><span>{row.title}</span></button>
        {row.conversations.map(chat => <button className={`zj-chat-link${sessionId === chat.sessionId && view === 'chat' ? ' is-active' : ''}`} key={chat.id} onClick={() => selectChat({ ...chat, goalId: row.id })}><span>{conversationTitle(chat)}</span></button>)}
      </div>)}</div>{!state.goals.length && <p className="zj-subtle" style={{ padding: '0 10px' }}>{t('noGoals')}</p>}
    </section>
    {conversations.some(row => !row.goalId) && <section><h2 className="zj-section-label">{t('ungrouped')}</h2>{conversations.filter(row => !row.goalId).map(row => <button key={row.id} className={`zj-chat-link${sessionId === row.sessionId ? ' is-active' : ''}`} onClick={() => selectChat(row)}><span>{conversationTitle(row)}</span></button>)}</section>}
    <div className="zj-voice-setup"><Button small quiet onClick={openRealtimeSettings}>{t('realtimeSettings')}</Button><details><summary>{t('compatibleVoiceInput')}</summary><VoiceSetup t={t} enableVoiceInput={enableVoiceInput} openVoiceSettings={openVoiceSettings}/></details></div>
  </aside><section className="zj-main"><nav className="zj-desk-nav" aria-label={t('deskNavigation')}>{DESK_PAGES.map(page => <button key={page} type="button" aria-current={selectedPage === page ? 'page' : undefined} className={selectedPage === page ? 'is-active' : ''} onClick={() => selectPage(page)}>{t(PAGE_LABELS[page])}</button>)}</nav><header className="zj-topbar"><h1>{title}</h1>{goal?.company && <span className="zj-subtle">{goal.company}</span>}
    <div className="zj-toolbar">{(view === 'chat' || chatExpanded) && <Button small quiet onClick={() => chatExpanded ? setChatExpanded(false) : navigate({ type: 'workspace' })}>{t('backToWorkbench')}</Button>}{!fullChat && !(view === 'chat' && interview?.mode === 'realtime') && <Button small quiet aria-expanded={showDock} onClick={() => setDockOpen(value => !value)}>{t(showDock ? 'hideAssistant' : 'showAssistant')}</Button>}<Button small quiet onClick={() => { setError(null); void refresh(); }}>{t('refresh')}</Button><Button small disabled={busy} onClick={() => newChat(goal?.id || null)}>{t('newChat')}</Button>{goal && <Button small primary disabled={busy} onClick={openInterview}>{t('newInterview')}</Button>}</div>
  </header>
    <div className="zj-review-note"><label>{t('dshWorkspace')} <select ref={workspaceAnchor} value={selectedWorkspace?.workspaceId || ''} onChange={event => setWorkspaceId(event.target.value)}><option value="">{t('selectWorkspace')}</option>{workspaceChoices.items.map(row => <option key={row.workspaceId} value={row.workspaceId}>{row.title}</option>)}</select></label>{!selectedWorkspace && <span>{t('workspaceRequired')}</span>}
      <Button small quiet onClick={() => run(async () => { if (!openWorkspaceManager?.()) throw new Error(t('unavailable')); })}>{t('manageWorkspaces')}</Button>
    </div>
    {(busy || snapshot.loading) && <div className="zj-progress" role="progressbar" aria-label={t('processing')}/>}
    <TaskCard operation={snapshot.operation} onCancel={cancelCurrent} onRetry={() => run(() => retryCurrent?.())} onOpen={openObject} t={t}/>
    {currentError && <div className="zj-error" role="alert"><strong>{t('errorTitle')}</strong><span>{errors.has(currentError.code) ? t(`error_${currentError.code}`) : currentError.message || t('error_REQUEST_FAILED')}</span><Button quiet small onClick={() => { setError(null); void refresh(); }}>{t('retry')}</Button></div>}
    {studio && <StudioHeader t={t} title={objectTitle} onBack={closeObject} previous={objectIndex > 0 ? visibleRows[objectIndex - 1] : null} next={objectIndex >= 0 ? visibleRows[objectIndex + 1] : null} onMove={row => openObject(row, selectedPage)} focus={focusResult} onFocus={() => { setFocusResult(value => !value); setDockOpen(true); }}/>}
    <div className={`zj-stage${fullChat ? ' is-chat' : ''}${studio ? ' is-studio' : ''}${showDock ? ' has-assistant' : ''}`}><div className={`zj-workspace-page${fullChat ? ' is-hidden' : ''}`} aria-hidden={fullChat || undefined}>
    {!snapshot.ready ? <div className="zj-body"><p className="zj-subtle">{t('loading')}</p></div> : !studio && DESK_PAGES.includes(view) ? <Collection key={view} page={view} rows={rows} value={collections[view]} onChange={patch => setCollections(values => ({ ...values, [view]: { ...values[view], ...patch } }))} onOpen={row => openObject(row, view)} onAddMaterial={() => addMaterial()} busy={busy} onStatusChange={(id, status) => perform('goal.update', { goalId: id, status })} onCreate={view === 'personal' ? () => addMaterial() : view === 'goals' ? () => setModal({ kind: 'goal' }) : view === 'home' ? () => newChat(null) : undefined} t={t}/> : view === 'result' ? <ResultStudio key={studio?.target.id} row={resultRow} state={state} t={t} busy={busy} onExport={exportFile} onEvidence={showEvidence} onAction={perform} onReviewVersion={reviewVersion} draft={drafts[`result:${studio?.target.id}`]} onDraftChange={value => saveDraft(`result:${studio?.target.id}`, value)}/> : view === 'personal' ? <Materials studio state={state} t={t} busy={busy} selectedId={materialId} selectedVersionId={materialVersionId} onSelect={id => { setMaterialId(id); setMaterialVersionId(null); }} onAdd={() => addMaterial()} onEdit={(material, version) => setModal({ kind: 'material', material, version })} onConfirm={confirmVersion} onExport={exportFile} onAssess={id => perform('assessment.run', { kind: 'resume', versionId: id })} onEvidence={showEvidence} onSource={id => run(() => readSource(id), data => setModal({ kind: 'source', data }))} onChatContext={askContext}/> : view === 'chat' && sessionId ? <>
      {(conversation?.materialVersionIds || []).map(id => versionEntry(state, id)).filter(entry => entry?.material.kind === 'resume').map(({ material, version }) => <div className="zj-review-note" key={version.id}><span>{t('resume')} · {material.title} · {t('version', { number: version.revision })}</span><span>{t('chatSnapshot')}</span></div>)}
      {interview ? <Interview key={interview.id} state={state} interview={interview} t={t} busy={busy || !sessionWorkspace} onAction={performInterview} onExport={exportFile} voiceApi={voiceApi} realtimeApi={realtimeApi} openRealtimeSettings={openRealtimeSettings} onChanged={refresh} nativeChat={null} onEvidence={showEvidence}
        answerDraft={drafts[`answer:${interview.id}:${interview.currentQuestionId}`]} onAnswerDraftChange={value => saveDraft(`answer:${interview.id}:${interview.currentQuestionId}`, value)}/> : null}
    </> : view === 'goal' && goal ? <div className="zj-body"><div className="zj-page-heading"><div><span className="zj-eyebrow">{t('goals')}</span><h2>{goal.title}</h2>{goal.description && <p>{goal.description}</p>}</div><div className="zj-actions"><Button small disabled={busy} onClick={() => setModal({ kind: 'editGoal', goal })}>{t('deskEditGoal')}</Button><Button small disabled={busy} onClick={() => perform('goal.update', { goalId: goal.id, status: goal.status === 'active' ? 'archived' : 'active' })}>{t(goal.status === 'active' ? 'deskArchive' : 'deskRestore')}</Button></div></div>
      <Tabs values={['overview','review','fit','rewrite']} active={tab} onChange={setTab} t={t}/>
      {tab === 'overview' ? <><div className="zj-form"><ResumeSelect state={state} value={versionId} onChange={setVersionId} t={t}/><p className="zj-subtle">{t('chatSnapshot')}</p></div><div className="zj-actions"><Button primary disabled={busy} onClick={() => newChat(goal.id)}>{t('newChat')}</Button><Button disabled={busy} onClick={openInterview}>{t('newInterview')}</Button></div>
        <GoalMaterials state={state} goal={goal} t={t} onAdd={() => addMaterial('job', goal.id)} onLink={() => setModal({ kind: 'linkMaterial' })} onChatContext={askContext}/>
        {goal.conversations.length > 0 && <section className="zj-card"><h3>{t('chat')}</h3>{goal.conversations.map(row => <div className="zj-attach" key={row.id}><div><strong>{conversationTitle(row)}</strong><span className="zj-subtle">{t(row.kind === 'interview' ? 'interview' : 'chat')}</span></div><Button small onClick={() => selectChat({ ...row, goalId: goal.id })}>{t('start')}</Button></div>)}</section>}
      </> : <Analysis state={state} goal={goal} tab={tab} t={t} busy={busy} onAction={perform} onExport={exportFile} selectedVersion={versionId} onSelectVersion={setVersionId} onReviewVersion={reviewVersion} onEvidence={showEvidence} onChatContext={askContext}
        draft={drafts[`analysis:${goal.id}:${versionId}:${tab}`]} onDraftChange={value => saveDraft(`analysis:${goal.id}:${versionId}:${tab}`, value)}/>}
    </div> : <div className="zj-body"><div className="zj-empty"><span className="zj-eyebrow">{t('tagline')}</span><h2>{t('homeTitle')}</h2><p>{t('homeNote')}</p><div className="zj-actions"><Button primary disabled={busy} onClick={() => newChat(null)}>{t('newChat')}</Button><Button onClick={() => setModal({ kind: 'goal' })}>{t('newGoal')}</Button><Button quiet onClick={() => addMaterial()}>{t('addMaterial')}</Button></div></div></div>}
  </div><aside className={`zj-assistant${showDock ? '' : ' is-hidden'}`} aria-label={t('assistant')} aria-hidden={!showDock || undefined}>
    <header className="zj-assistant-head"><div><strong>{t('assistant')}</strong><span className="zj-subtle">{conversation ? conversationTitle(conversation) : t('noConversations')}</span></div><div className="zj-actions">
      {!fullChat && sessionId && <Button small quiet onClick={() => studio ? setChatExpanded(true) : selectChat(conversation || { sessionId, goalId })}>{t('expandChat')}</Button>}
      {!fullChat && <Button small quiet onClick={() => setDockOpen(false)}>{t('hideAssistant')}</Button>}
    </div></header>
    {conversation && <div className="zj-assistant-context"><span>{conversation.goalId ? state.goals.find(row => row.id === conversation.goalId)?.title || t('goals') : t('ungrouped')}</span>
      <span>{(conversation.materialVersionIds || []).map(id => versionEntry(state, id)).filter(Boolean).map(({ material, version }) => `${material.title} · ${t('version', { number: version.revision })}`).join(' / ')}</span></div>}
    {conversation && !conversation.goalId && state.goals.length > 0 && <div className="zj-assistant-context"><Button small onClick={() => setModal({ kind: 'bindConversation' })}>{t('bindConversation')}</Button></div>}
    {context && context.sessionId === sessionId && <section className="zj-context-preview" aria-label={t('selectedContext')}><div className="zj-page-heading"><strong>{context.title} · {t('version', { number: context.revision })}</strong><Button small quiet disabled={busy} onClick={() => setContext(null)}>{t('cancelContext')}</Button></div><details><summary>{t('previewContext')}</summary><pre>{context.text}</pre></details><p className="zj-subtle">{t('contextPreviewNote')}</p><Button small primary disabled={busy} onClick={addContextDraft}>{t('addToChatDraft')}</Button></section>}
    <ReceiptList receipts={state.receipts} onOpen={openObject} onUndo={undoReceipt} busy={busy} t={t}/>
    {newestUndo && <div className="zj-receipt-undo"><Button small quiet disabled={busy} title={t('deskUndoNote')} onClick={() => undoReceipt(newestUndo)}>{t('deskUndoLast')}</Button></div>}
    {contextNotice && <p className="zj-context-notice" role="status">{contextNotice}</p>}
    {!interview && <div className="zj-suggestions">{['deskSuggestReview', 'deskSuggestPrepare'].map(key => <Button small quiet key={key} disabled={busy} onClick={() => prepareSuggestion(key)}>{t(key)}</Button>)}</div>}
    {nativeChat || <div className="zj-assistant-empty"><p>{t('assistantEmpty')}</p><Button primary disabled={busy} onClick={() => newChat(goal?.id || null)}>{t('newChat')}</Button></div>}
  </aside></div></section>
    {modal?.kind === 'goal' && <GoalForm t={t} busy={busy} saving={localPending > 0} draft={drafts.goal} onDraftChange={value => saveDraft('goal', value)} onClose={() => setModal(null)} onSave={input => run(() => action('goal.create', input), value => { saveDraft('goal', undefined); if (currentModal.current === modal) { setModal(null); selectGoal(value.id); } })}/>}
    {modal?.kind === 'editGoal' && <GoalForm t={t} busy={busy} saving={localPending > 0} editing draft={drafts[`goal:${modal.goal.id}`] || modal.goal} onDraftChange={value => saveDraft(`goal:${modal.goal.id}`, value)} onClose={() => setModal(null)} onSave={input => run(() => action('goal.update', { goalId: modal.goal.id, ...input }), () => { saveDraft(`goal:${modal.goal.id}`, undefined); setModal(null); })}/>}
    {modal?.kind === 'material' && <MaterialForm key={materialDraftKey(modal)} t={t} busy={busy} saving={localPending > 0} {...modal} draft={drafts[materialDraftKey(modal)]} onDraftChange={value => saveDraft(materialDraftKey(modal), value)} onClose={() => setModal(null)} onSave={(name, input) => run(() => action(name, input), materialSaved)} onUpload={(file, metadata) => run(() => upload(file, metadata), materialSaved)}/>}
    {modal?.kind === 'linkMaterial' && goal && <MaterialPicker t={t} state={state} busy={busy} onClose={() => setModal(null)} onSelect={id => run(() => action('goal.linkMaterial', { goalId: goal.id, versionId: id }), () => setModal(null))}/>}
    {modal?.kind === 'interview' && goal && <InterviewForm key={goal.id} t={t} state={state} goal={goal} busy={busy} saving={localPending > 0} selectedVersion={versionId}
      draft={drafts[`interview:${goal.id}`]} onDraftChange={value => { saveDraft(`interview:${goal.id}`, value); setVersionId(value.versionId); }}
      onClose={() => setModal(null)} onStart={input => run(() => startInterview({ ...input, workspaceId: selectedWorkspace?.workspaceId }), result => {
        saveDraft(`interview:${goal.id}`, undefined); if (currentModal.current === modal) { setModal(null); selectChat({ goalId: goal.id, sessionId: result.sessionId }); }
      })}/>}
    {modal?.kind === 'citation' && <Modal title={source?.title || t('evidence')} t={t} onClose={() => setModal(null)}>{source ? <>{source.revision && <p className="zj-subtle">{t('version', { number: source.revision })}</p>}<div className="zj-paper-content">{segments.before}{segments.quote && <mark>{segments.quote}</mark>}{segments.after}</div></> : <p className="zj-subtle">{t('unavailable')}</p>}</Modal>}
    {modal?.kind === 'source' && <SourceDialog key={modal.data.versionId} data={modal.data} t={t} onClose={() => setModal(null)} loadOriginal={loadOriginal} onDownload={id => run(() => downloadOriginal(id))}/>}
    {modal?.kind === 'bindConversation' && conversation && <Modal title={t('bindConversation')} t={t} onClose={() => setModal(null)}>{state.goals.map(row => <div className="zj-attach" key={row.id}><strong>{row.title}</strong><Button small disabled={busy} onClick={() => run(() => action('conversation.link', { goalId: row.id, sessionId: conversation.sessionId, title: conversation.title, kind: conversation.kind }), () => { selectChat({ ...conversation, goalId: row.id }); setModal(null); })}>{t('link')}</Button></div>)}</Modal>}
  </div></TaskCancelContext.Provider>;
}
