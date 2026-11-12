import http from 'node:http';
import https from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { isIP, type LookupFunction } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { extractPublicJob } from './html-job-extractor.ts';
import { abortable, isJobVerificationUrl, resolvePublicJobUrl, type PublicResolver } from './public-url-policy.ts';

export interface JobHttpResponse { status: number; headers: Record<string, string | undefined>; body: Uint8Array }
export interface JobHttpRequest { resolved: Awaited<ReturnType<typeof resolvePublicJobUrl>>; signal: AbortSignal; maximumBytes: number }
export type JobHttpTransport = (input: JobHttpRequest) => Promise<JobHttpResponse>;
function cancelled(): Error { return new Error('MATERIALS_ACQUISITION_CANCELLED'); }
async function readResponse(response: IncomingMessage, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  const length = Number(response.headers['content-length']);
  if (Number.isFinite(length) && length > maximum) { response.destroy(); throw new Error('MATERIALS_PAGE_TOO_LARGE'); }
  const encoding = (response.headers['content-encoding'] ?? 'identity').toLowerCase().trim();
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : null;
  if (!decoder && encoding !== 'identity') { response.destroy(); throw new Error('MATERIALS_FETCH_FAILED'); }
  let compressed = 0, failure: Error | undefined;
  response.on('data', (chunk: Buffer) => { compressed += chunk.length; if (compressed > maximum) {
    failure = new Error('MATERIALS_PAGE_TOO_LARGE'); response.destroy(failure); decoder?.destroy(failure);
  } });
  response.on('error', error => decoder?.destroy(error));
  const stream = decoder ? response.pipe(decoder) : response;
  const chunks: Buffer[] = []; let bytes = 0;
  const abort = () => { const error = cancelled(); response.destroy(error); decoder?.destroy(error); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > maximum) { failure = new Error('MATERIALS_PAGE_TOO_LARGE'); response.destroy(); decoder?.destroy(); throw failure; }
      chunks.push(buffer);
    }
    if (failure) throw failure; return Buffer.concat(chunks);
  } finally { signal.removeEventListener('abort', abort); }
}
/** The request connects only to a DNS address admitted immediately before this hop. */
export const pinnedJobHttpTransport: JobHttpTransport = ({ resolved, signal, maximumBytes }) => new Promise((resolve, reject) => {
  const selected = resolved.selected;
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (signal.aborted) { callback(cancelled(), '', 0); return; }
    if (typeof options === 'object' && options.all) callback(null, [selected]); else callback(null, selected.address, selected.family);
  };
  const request = (resolved.url.protocol === 'https:' ? https : http).request(resolved.url, {
    method: 'GET', agent: false, family: selected.family, lookup,
    ...(resolved.url.protocol === 'https:' && !isIP(resolved.hostname) ? { servername: resolved.hostname } : {}),
    headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'ZhijingAI/0.1 JobMaterialImport' },
  }, response => {
    const status = response.statusCode ?? 0;
    const headers = { 'content-type': response.headers['content-type'], location: response.headers.location };
    // Redirect and challenge bodies are neither needed nor executed.
    if (status >= 300 && status < 400 || [401, 403, 429].includes(status)) { response.destroy(); resolve({ status, headers, body: new Uint8Array() }); return; }
    void readResponse(response, maximumBytes, signal).then(body => resolve({ status, headers, body }), reject);
  });
  const abort = () => request.destroy(cancelled()); signal.addEventListener('abort', abort, { once: true });
  request.on('close', () => signal.removeEventListener('abort', abort));
  request.on('error', reject);
  if (signal.aborted) abort(); else request.end();
});
function decodeHtml(body: Uint8Array, contentType: string): string {
  const headerEncoding = /charset\s*=\s*["']?([^;\s"']+)/iu.exec(contentType)?.[1];
  const meta = Buffer.from(body.subarray(0, 4096)).toString('ascii');
  const encoding = (headerEncoding ?? /charset\s*=\s*["']?([a-zA-Z0-9_-]+)/iu.exec(meta)?.[1] ?? 'utf-8').toLowerCase();
  if (!['utf-8', 'utf8', 'gbk', 'gb2312', 'gb18030', 'big5', 'windows-1252', 'iso-8859-1'].includes(encoding)) throw new Error('MATERIALS_FETCH_FAILED');
  try { return new TextDecoder(encoding).decode(body); } catch { throw new Error('MATERIALS_FETCH_FAILED'); }
}
export function createHttpJobSource(options: { resolver?: PublicResolver; transport?: JobHttpTransport; timeoutMs?: number; maximumBytes?: number; maximumRedirects?: number; now?: () => number } = {}) {
  const maximum = options.maximumBytes ?? 2 * 1024 * 1024, redirects = options.maximumRedirects ?? 3;
  return async (input: string, outerSignal: AbortSignal) => {
    const controller = new AbortController(); let timedOut = false;
    const abort = () => controller.abort(); outerSignal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 20000);
    try {
      outerSignal.throwIfAborted(); let target = input;
      for (let count = 0; count <= redirects; count++) {
        const resolved = await resolvePublicJobUrl(target, { resolver: options.resolver, signal: controller.signal });
        if (isJobVerificationUrl(resolved.url.href)) throw new Error('MATERIALS_SITE_VERIFICATION');
        const response = await abortable((options.transport ?? pinnedJobHttpTransport)({ resolved, signal: controller.signal, maximumBytes: maximum }), controller.signal);
        controller.signal.throwIfAborted();
        if ([401, 403, 429].includes(response.status)) throw new Error('MATERIALS_SITE_VERIFICATION');
        if (response.status >= 300 && response.status < 400) {
          if (!response.headers.location || count === redirects) throw new Error('MATERIALS_FETCH_FAILED');
          const next = new URL(response.headers.location, resolved.url);
          if (isJobVerificationUrl(next.href)) throw new Error('MATERIALS_SITE_VERIFICATION');
          if (resolved.url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('MATERIALS_URL_REJECTED');
          target = next.href; continue;
        }
        if (response.status < 200 || response.status >= 300 || !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(response.headers['content-type'] ?? '')) throw new Error('MATERIALS_FETCH_FAILED');
        if (response.body.byteLength > maximum) throw new Error('MATERIALS_PAGE_TOO_LARGE');
        return extractPublicJob(decodeHtml(response.body, response.headers['content-type']!), input, resolved.url.href, (options.now ?? Date.now)());
      }
      throw new Error('MATERIALS_FETCH_FAILED');
    } catch (error) {
      if (controller.signal.aborted || outerSignal.aborted) throw new Error(timedOut ? 'MATERIALS_FETCH_TIMEOUT' : 'MATERIALS_ACQUISITION_CANCELLED');
      const message = error instanceof Error ? error.message : '';
      if (/^MATERIALS_(?:URL_REJECTED|FETCH_FAILED|PAGE_TOO_LARGE|SITE_VERIFICATION|NO_JOB_TEXT)$/u.test(message)) throw error;
      throw new Error('MATERIALS_FETCH_FAILED');
    } finally { clearTimeout(timer); outerSignal.removeEventListener('abort', abort); }
  };
}
