export const SESSION_PREFIX = 'dsh-resource://zhijingchat/session/';

export function sessionAddress(sessionId) {
  if (!sessionId) throw new Error('Session identity required');
  return SESSION_PREFIX + encodeURIComponent(sessionId);
}

export function parseSessionAddress(address) {
  const url = new URL(address);
  if (url.protocol !== 'dsh-resource:' || url.hostname !== 'zhijingchat' || !url.pathname.startsWith('/session/')) throw new Error('Invalid career session address');
  const id = decodeURIComponent(url.pathname.slice('/session/'.length));
  if (!id || id.includes('/')) throw new Error('Invalid career session identity');
  return id;
}

export function careerSessionProvider(sessions) {
  return {
    protocol: 'zhijingchat',
    async *open(address, { signal }) {
      let reference;
      try {
        const id = parseSessionAddress(address);
        if (signal.aborted) return;
        await sessions.refresh();
        if (signal.aborted) return;
        reference = sessions.retain(id, { source: 'zhijingChat', signal });
        yield { ok: true, value: { reference } };
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      } catch (error) {
        if (!signal.aborted) yield { ok: false, error: { code: 'INTERNAL_ERROR', message: error.message } };
      } finally { reference?.release(); }
    },
  };
}
