import React from 'react';
import { sessionAddress } from './session.js';

function ChatViews({ renderSlot }) { return <>{renderSlot('conversation.session', { view: 'chat' })}</>; }

export function Conversation({ useSession, renderFactorySlot }) {
  const session = useSession(value => value);
  // This occurrence already owns an exact Session in a chosen Workspace.
  // The generic new-session hero changes global navigation when its Workspace
  // picker is used, so it must not replace this fixed material-bound Session.
  const phase = session.openState === 'loading' ? 'settling' : 'active';
  return <div className="zj-native-conversation">{renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero: false }, { slots: { views: ChatViews } })}</div>;
}

export function NativeChat({ sessionId, useResource, SessionProvider, renderSlot, t }) {
  const resource = useResource(sessionAddress(sessionId));
  return <div className="zj-chat">{resource.status === 'failed' ? <p className="zj-error" role="alert">{t('errorTitle')} {resource.failure?.message}</p> : !resource.value ? <p className="zj-subtle">{t('loading')}</p> : <SessionProvider session={resource.value.reference}>{renderSlot('zhijing.conversation', {})}</SessionProvider>}</div>;
}
