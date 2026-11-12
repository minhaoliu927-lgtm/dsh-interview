export const DESK_PAGES = ['home', 'personal', 'goals', 'interviews', 'reports'];
export const PAGE_LABELS = { home: 'chat', personal: 'personal', goals: 'goals', interviews: 'interview', reports: 'deskReports' };
export function collectionRows(state, page, native = {}) {
  const goalTitle = id => state.goals.find(row => row.id === id)?.title || '';
  if (page === 'personal') return state.materials.map(row => ({ ...row, entity: row, kind: 'material', category: row.kind,
    versionId: row.latestVersionId, description: row.versions.find(v => v.id === row.latestVersionId)?.text || '', count: row.versions.length }));
  if (page === 'goals') return state.goals.map(row => ({ ...row, entity: row, kind: 'goal', category: row.status, description: [row.company, row.description].filter(Boolean).join(' · '), count: row.conversations.length }));
  if (page === 'interviews') return state.interviews.map(row => ({ ...row, entity: row, kind: 'interview', category: row.status,
    title: native[row.sessionId]?.title || goalTitle(row.goalId), description: row.questions?.find(q => q.id === row.currentQuestionId)?.text || '', count: row.questions?.filter(q => q.answer).length || 0 }));
  if (page === 'reports') return [
    ...state.reports.map(row => ({ ...row, entity: row, kind: 'report', category: 'report', title: goalTitle(row.goalId), description: row.summary || '' })),
    ...state.assessments.map(row => ({ ...row, entity: row, kind: 'assessment', category: row.kind === 'fit' ? 'fit' : 'review', title: goalTitle(row.goalId) || state.materials.find(m => m.versions.some(v => v.id === row.versionId))?.title, description: row.summary || '' })),
    ...state.rewrites.map(row => ({ ...row, entity: row, kind: 'rewrite', category: 'rewrite', title: goalTitle(row.goalId), description: row.items?.map(item => item.reason).join(' · ') || '' }))];
  return (state.conversations || []).filter(row => row.kind === 'chat').map(row => ({ ...row, entity: row, kind: 'conversation', category: row.goalId ? 'goals' : 'ungrouped', title: native[row.sessionId]?.title || row.title, description: goalTitle(row.goalId) }));
}
export function filterCollection(rows, { query = '', filter = 'all', sort = 'newest' } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(row => (filter === 'all' || row.category === filter) && (!needle || `${row.title || ''}\n${row.description || ''}`.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => sort === 'title' ? String(a.title || '').localeCompare(String(b.title || '')) || a.id.localeCompare(b.id)
      : (sort === 'oldest' ? 1 : -1) * String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id));
}
export function objectKey(target) { return `${target.kind}:${target.id}`; }
