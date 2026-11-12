import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRealtimeProvider, RealtimeError, validateRealtimeConfig } from './realtime-provider.js';

const MAX_DURATION_MS = 30_000;
const SAMPLE_RATE = 24_000;
const MAX_PCM_BYTES = SAMPLE_RATE * 2 * 3;
const INSTRUCTIONS = '这是一次音频服务测试。请仅用中文自然地说“你好，音频测试成功。”，然后停止。不要提问，不要调用工具，不要添加其他内容。';
const error = (code, message, status = 502) => new RealtimeError(code, message, status);
const safeError = cause => cause instanceof RealtimeError ? cause : error('probe-failed', '音频 API 测试未完成，请检查 DSH 语音设置后重试。');

function wave(pcm) {
  const bytes = Buffer.alloc(44 + pcm.length);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(pcm.length, 40); pcm.copy(bytes, 44);
  const base64 = bytes.toString('base64'); bytes.fill(0);
  return { mimeType: 'audio/wav', base64 };
}

/** Host-only, output-only probe. No interview, persistence, microphone or text model. */
export function createRealtimeProbe({ getConfig, resolveCredential, socketFactory, timeoutMs = MAX_DURATION_MS } = {}) {
  if (typeof getConfig !== 'function' || typeof resolveCredential !== 'function' || typeof socketFactory !== 'function') {
    throw error('invalid-adapter', '音频测试需要宿主设置、凭据和传输服务。', 400);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > MAX_DURATION_MS) {
    throw error('invalid-limits', '音频测试时限无效。', 400);
  }
  let active, closed = false;
  function test(input = {}, { signal } = {}) {
    if (closed) return Promise.reject(error('cancelled', '音频 API 测试已关闭。', 499));
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length
      || (signal !== undefined && !(signal instanceof AbortSignal))) {
      return Promise.reject(error('invalid-probe-input', '音频测试仅使用 DSH 中已保存的语音设置。', 400));
    }
    if (active) return Promise.reject(error('BUSY', '已有音频 API 测试正在进行。', 409));
    const run = { startedAt: performance.now(), controller: new AbortController(), pcm: Buffer.alloc(MAX_PCM_BYTES),
      bytes: 0, hasSound: false, transcript: false, ready: null, firstAudio: null, settled: false };
    active = run;
    const elapsed = () => Math.max(0, Math.round(performance.now() - run.startedAt));
    return new Promise((resolve, reject) => {
      const abort = () => finish(error('cancelled', '音频 API 测试已取消。', 499));
      const finish = (cause, result) => {
        if (run.settled) return;
        run.settled = true; clearTimeout(run.timer); signal?.removeEventListener('abort', abort);
        // Cancel generation before disconnecting, then revoke late credentials,
        // socket construction and provider events through the same AbortSignal.
        if (run.ready !== null) { try { run.provider?.cancelResponse(); } catch { /* Already disconnected. */ } }
        run.controller.abort();
        try { run.provider?.close(); } catch { /* Provider cleanup must not mask the result. */ }
        run.pcm.fill(0); run.pcm = null; active = undefined;
        if (cause) reject(safeError(cause)); else resolve(result);
      };
      run.cancel = abort;
      const complete = () => {
        if (!run.bytes || !run.hasSound) return finish(error('probe-no-audio', '音频服务未返回可试听的声音。'));
        if (!run.transcript) return finish(error('probe-no-transcript', '音频服务未返回测试字幕。'));
        finish(undefined, { ok: true, provider: 'qwen-realtime', model: run.config.model,
          latencyMs: { ready: run.ready, firstAudio: run.firstAudio, total: elapsed() },
          audio: wave(run.pcm.subarray(0, run.bytes)), checks: { handshake: true, audio: true, transcript: true } });
      };
      const onEvent = event => {
        if (run.settled) return;
        if (event.type === 'ready') { run.ready = elapsed(); return; }
        if (event.type === 'error') return finish(error(event.code, event.message, event.status));
        if (event.type === 'closed') return finish(error('connection-closed', '音频测试连接已断开，请重试。'));
        if (!run.requested) return;
        if (event.type === 'response-started' && !run.responseId) { run.responseId = event.responseId; return; }
        if (!run.responseId || event.responseId !== run.responseId) return;
        if (event.type === 'audio') {
          if (run.firstAudio === null) run.firstAudio = elapsed();
          if (run.bytes < MAX_PCM_BYTES) {
            const chunk = Buffer.from(event.audioBase64, 'base64');
            const count = Math.min(chunk.length, MAX_PCM_BYTES - run.bytes);
            chunk.copy(run.pcm, run.bytes, 0, count);
            if (!run.hasSound) run.hasSound = chunk.subarray(0, count).some(byte => byte !== 0);
            run.bytes += count; chunk.fill(0);
          }
        } else if (event.type === 'output-transcript' || event.type === 'output-transcript-delta') {
          run.transcript ||= Boolean((event.text ?? event.delta)?.trim());
        } else if (event.type === 'response-done') {
          if (event.status !== 'completed') return finish(error('probe-response-failed', '音频服务未完成测试回复。'));
          return complete();
        }
        if (run.bytes === MAX_PCM_BYTES && run.hasSound && run.transcript) complete();
      };
      run.timer = setTimeout(() => finish(error('probe-timeout', '音频 API 测试超过 30 秒，请检查设置后重试。', 504)), timeoutMs);
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      void (async () => {
        try {
          const config = await getConfig();
          if (run.settled) return;
          run.config = validateRealtimeConfig(config);
          run.provider = createRealtimeProvider({ resolveCredential, socketFactory, onEvent,
            connectTimeoutMs: Math.min(15_000, timeoutMs), responseTimeoutMs: timeoutMs, sessionTimeoutMs: timeoutMs,
            limits: { maxEvents: 2048, maxTextChars: 2000, maxOutputResponseBytes: 480_000 } });
          await run.provider.connect({ config: run.config, sessionId: `audio-probe-${randomUUID()}`, epoch: 1,
            instructions: INSTRUCTIONS, signal: run.controller.signal });
          if (run.settled) return;
          run.requested = true; run.provider.requestResponse();
        } catch (cause) { finish(cause); }
      })();
    });
  }
  return { test, close() { closed = true; active?.cancel(); } };
}
