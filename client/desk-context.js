import { versionEntry } from './model.js';

/** Resolve only a reviewed immutable version. A selected passage must match it exactly. */
export function materialChatContext(state, versionId, passage) {
  const entry = versionEntry(state, versionId);
  if (!entry?.version.confirmed || typeof entry.version.text !== 'string') return null;
  const { material, version } = entry;
  if (passage && (passage.versionId !== version.id || !Number.isInteger(passage.start) || !Number.isInteger(passage.end)
    || passage.start < 0 || passage.end <= passage.start || passage.end > version.text.length
    || version.text.slice(passage.start, passage.end) !== passage.text)) return null;
  const text = passage?.text ?? version.text;
  if (!text.trim()) return null;
  return { versionId, materialId: material.id, kind: material.kind, title: material.title, revision: version.revision,
    text, ...(passage ? { start: passage.start, end: passage.end } : {}) };
}

export function contextDraft(context, t) {
  if (!context?.text?.trim()) throw new Error(t('contextUnavailable'));
  return t('contextDraftText', { title: context.title, version: t('version', { number: context.revision }),
    versionId: context.versionId, text: context.text });
}

/** Public DSH draft initialization: preserve existing text/attachments and never submit. */
export async function appendNativeDraft(sessions, conversation, sessionId, prompt) {
  if (!sessionId || typeof sessions?.using !== 'function' || typeof conversation?.input?.requestDraftInitialization !== 'function')
    throw Object.assign(new Error('DSH native draft preparation is unavailable.'), { code: 'NATIVE_DRAFT_UNAVAILABLE' });
  return sessions.using(sessionId, { source: 'zhijingChat' }, async reference => {
    const binding = await reference.ready;
    const result = conversation.input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'append' });
    if (result !== 'applied') throw Object.assign(new Error('The conversation draft is busy. Try again when submission finishes.'), { code: 'NATIVE_DRAFT_BLOCKED' });
    return result;
  });
}
