/** Same-origin transport. Credentials stay with the DSH connection. */
import { createRealtimeTransport } from './voice/realtime-transport.js';
export function createApi(fetchImpl = globalThis.fetch.bind(globalThis)) {
  function requestIdentity(options) {
    if (options?.requestId === undefined) return {};
    if (typeof options.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(options.requestId)) {
      throw Object.assign(new Error('Invalid request identity'), { code: 'INVALID_REQUEST_ID' });
    }
    return { requestId: options.requestId };
  }
  async function json(path, body, { signal } = {}) {
    signal?.throwIfAborted();
    const response = await fetchImpl(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal,
    });
    let envelope;
    try { envelope = await response.json(); }
    catch { throw Object.assign(new Error('Invalid server response'), { code: 'INVALID_RESPONSE' }); }
    if (!response.ok || envelope?.ok !== true) {
      throw Object.assign(new Error(envelope?.error?.message || `HTTP ${response.status}`), {
        code: envelope?.error?.code || 'REQUEST_FAILED',
      });
    }
    return envelope.data;
  }
  const request = (action, input = {}, options) => json('/zhijing/api', { action, input, ...requestIdentity(options) }, options);
  async function download(path, input, fallbackName, { signal } = {}) {
    const response = await fetchImpl(path, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal });
    if (!response.ok) {
      const envelope = await response.json();
      throw Object.assign(new Error(envelope?.error?.message || `HTTP ${response.status}`), { code: envelope?.error?.code || 'EXPORT_FAILED' });
    }
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') || '')?.[1];
    let filename = fallbackName;
    if (encoded) { try { filename = decodeURIComponent(encoded); } catch { /* Keep the client-owned fallback for malformed server metadata. */ } }
    return { blob: await response.blob(), filename: filename.replace(/[\\/:*?"<>|]/g, '_') };
  }
  return {
    request,
    async upload(file, { title, kind }, options) {
      const identity = requestIdentity(options);
      options?.signal?.throwIfAborted();
      if (file.size > 25 * 1024 * 1024) throw Object.assign(new Error('File exceeds 25 MB'), { code: 'FILE_TOO_LARGE' });
      const bytes = new Uint8Array(await file.arrayBuffer());
      options?.signal?.throwIfAborted();
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return json('/zhijing/upload', { filename: file.name, mime: file.type, dataBase64: btoa(binary), title: title || file.name, kind, ...identity }, options);
    },
    exportDocument: (kind, id, format, options) => download('/zhijing/export', { kind, id, format }, `zhijing-${kind}-${id}.${format}`, options),
    original: (versionId, options) => download('/zhijing/original', { versionId }, 'zhijing-original', options),
    voice: {
      catalog: options => request('voice.catalog', {}, options),
      transcribe: (input, options) => request('voice.transcribe', input, options),
    },
    realtime: { ...createRealtimeTransport(fetchImpl), catalog: options => request('realtime.catalog', {}, options) },
  };
}

export function saveDownload({ blob, filename }, documentImpl = document, urlApi = URL) {
  const url = urlApi.createObjectURL(blob);
  const anchor = documentImpl.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => urlApi.revokeObjectURL(url), 1000);
}
