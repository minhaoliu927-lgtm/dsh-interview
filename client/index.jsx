import React from 'react';
import { createApi, saveDownload } from './api.js';
import { createCareerClient } from './model.js';
import { careerSessionProvider } from './session.js';
import { interviewPrompt, submitNativePrompt } from './native-interview.js';
import { submitReviewedVoiceAnswer } from './voice/review.js';
import { DSH_VOICE_BUNDLE, enableDshVoice } from './voice/setup.js';
import { Conversation } from './native-chat.jsx';
import { App } from './workbench.jsx';
import { Mark } from './components.jsx';
import { registerRealtimeSettings } from './realtime-settings.jsx';
import { en, zh } from '../locale/dictionaries.js';

export const inject = ['slots', 'locale', 'sessions', 'resources', 'workspaces', 'configForms', 'remote', 'remote.credentials'];

export function apply(ctx) {
  const namespace = 'zhijing';
  const api = createApi();
  const client = createCareerClient(api);
  ctx.effect(() => () => client.dispose(), 'zhijing: career data owner');
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'zhijing: dictionaries');
  const t = ctx.locale.bind(namespace);
  ctx.effect(() => registerRealtimeSettings(ctx, namespace), 'zhijing: official realtime settings');
  ctx.effect(() => ctx.resources.register(careerSessionProvider(ctx.sessions)), 'zhijing: native session resources');
  const actions = {
    hooks: { career: client.source, nativeSessions: ctx.sessions.list, workspaceChoices: ctx.workspaces.list },
    refresh: client.refresh,
    cancelCurrent: client.cancelCurrent,
    action: client.action,
    upload: client.upload,
    voiceApi: api.voice,
    realtimeApi: api.realtime,
    openRealtimeSettings: () => { const navigation = ctx.get('pluginNavigation'); navigation?.openBundle('dsh-interview'); return Boolean(navigation); },
    readSource: versionId => api.request('material.source', { versionId }),
    loadOriginal: api.original,
    async downloadOriginal(versionId) { saveDownload(await api.original(versionId)); },
    openVoiceSettings: () => { const navigation = ctx.get('pluginNavigation'); navigation?.openBundle(DSH_VOICE_BUNDLE); return Boolean(navigation); },
    enableVoiceInput: ({ signal } = {}) => enableDshVoice({ getManager: () => ctx.get('remote.pluginManager'),
      openSettings: () => actions.openVoiceSettings(), signal }),
    openWorkspaceManager: () => { const layout = ctx.get('layout'); layout?.selectPanel(null); return Boolean(layout); },
    async createConversation(goalId, title, versionId, workspaceId) {
      if (!ctx.workspaces.list.getSnapshot().items.some(row => row.workspaceId === workspaceId)) throw Object.assign(new Error(t('workspaceRequired')), { code: 'WORKSPACE_REQUIRED' });
      const sessionId = await ctx.sessions.create({ workspaceId });
      return client.action('conversation.link', { goalId: goalId || null, sessionId, title, kind: 'chat', ...(versionId ? { versionId } : {}) });
    },
    async startInterview(input) {
      if (!ctx.workspaces.list.getSnapshot().items.some(row => row.workspaceId === input.workspaceId)) throw Object.assign(new Error(t('workspaceRequired')), { code: 'WORKSPACE_REQUIRED' });
      if (input.mode === 'realtime') return client.action('realtime.create', input);
      const sessionId = await ctx.sessions.create({ workspaceId: input.workspaceId });
      await client.action('conversation.link', { goalId: input.goalId, versionId: input.versionId, sessionId, title: t('interview'), kind: 'interview' });
      return client.perform(signal => submitNativePrompt(ctx.sessions, sessionId, interviewPrompt('interview.start', input, t), signal));
    },
    async interviewAction(name, input) {
      const interview = client.source.getSnapshot().data.interviews.find(row => row.id === input.interviewId);
      if (!interview) throw new Error(t('unavailable'));
      if (interview.mode === 'realtime') return client.action(name, input);
      return client.perform(signal => name === 'interview.answer'
        ? submitReviewedVoiceAnswer({ api, submit: (text, scope) => submitNativePrompt(ctx.sessions, interview.sessionId, interviewPrompt(name, { ...input, text }, t), scope) }, { ...input, interviewId: interview.id }, signal)
        : submitNativePrompt(ctx.sessions, interview.sessionId, interviewPrompt(name, input, t), signal));
    },
    async download(kind, id, format) { saveDownload(await api.exportDocument(kind, id, format)); },
  };
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: 'zhijing', locale: namespace,
    children: { 'zhijing.conversation': { kind: 'single', scope: 'session' } },
    inject: () => actions,
  }, App)), 'zhijing: workbench');
  ctx.effect(() => ctx.slots.inject('zhijing.conversation', () => ctx.slots.register({
    name: 'zhijing.conversation', locale: namespace,
  }, Conversation)), 'zhijing: shared conversation');
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'zhijing', order: 8, label: () => t('panel'), locale: namespace,
  }, Mark)), 'zhijing: sidebar');
}
