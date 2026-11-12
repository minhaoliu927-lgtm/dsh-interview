const failure = (code, message = code) => Object.assign(new Error(message), { code });

/** Same-origin authenticated stream; upstream credentials never cross this API. */
export function createRealtimeTransport(fetchImpl) {
  const post = (path, input, signal) => fetchImpl(path, { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal });
  async function check(response) {
    if (response.ok) return;
    let envelope;
    try { envelope = await response.json(); } catch { /* Do not expose proxy HTML. */ }
    throw failure(envelope?.error?.code ?? 'REALTIME_REQUEST_FAILED', envelope?.error?.message ?? 'Voice connection failed');
  }
  return {
    async control(input, { signal } = {}) {
      const response = await post('/zhijing/realtime/control', input, signal); await check(response);
      const envelope = await response.json();
      if (envelope?.ok !== true) throw failure('REALTIME_INVALID_RESPONSE');
      return envelope.data;
    },
    async open(input, { signal, onEvent } = {}) {
      const response = await post('/zhijing/realtime/open', input, signal); await check(response);
      if (!response.headers.get('content-type')?.startsWith('application/x-ndjson') || !response.body) throw failure('REALTIME_INVALID_RESPONSE');
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '';
      const emit = async line => {
        if (!line.trim()) return;
        let event; try { event = JSON.parse(line); } catch { throw failure('REALTIME_INVALID_RESPONSE'); }
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') throw failure('REALTIME_INVALID_RESPONSE');
        await onEvent?.(event);
      };
      try {
        while (true) {
          signal?.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 1024 * 1024) throw failure('REALTIME_EVENT_TOO_LARGE');
          let boundary;
          while ((boundary = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1); await emit(line);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) throw failure('REALTIME_STREAM_TRUNCATED');
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    },
  };
}
