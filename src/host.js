import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCareerService } from './domain/index.js';
import { createVoiceService } from './voice/service.js';
import { createModelGenerator } from './model.js';
import { registerCareerTools } from './tools.js';
import { registerCareerSkill } from './skills.js';
import WebSocket from 'ws';
import { createRealtimeService } from './voice/realtime-service.js';
import { createRealtimeProbe } from './voice/realtime-probe.js';
import { createNativeSessionRecorder } from './voice/native-session.js';
import { realtimeConfig, realtimeCatalog } from './voice/config.js';
export { Config } from './voice/config.js';

export const name = 'dsh-interview-desk';
export const inject = ['dshHomePath', 'tools', 'skills'];

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function readJson(req, limit = 48 * 1024 * 1024) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw fail('CONTENT_TYPE', '请发送 JSON 请求。', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw fail('REQUEST_TOO_LARGE', '内容超过允许大小。', 413); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('INVALID_JSON', '请求内容不是有效 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('INVALID_INPUT', '请求必须是一个对象。');
  return value;
}
export function requestRejection(ctx, req) {
  const connection = ctx.get('connection');
  if (typeof connection?.requestRejection !== 'function') return 403;
  const rejected = connection.requestRejection({ headers: req.headers });
  if (rejected) return rejected;
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return 403;
  return undefined;
}
export function publicError(error, aborted = false) {
  if (aborted) return { status: 499, code: 'CANCELLED', message: '操作已取消。' };
  // Native filesystem, SQLite and transport errors may contain local paths or
  // request details. Only our deliberately authored business errors are public.
  const business = ['VoiceError', 'RealtimeError'].includes(error?.name) || ['CANCELLED', 'BUSY'].includes(error?.code) || (typeof error?.code === 'string'
    && /^[A-Z]+_[A-Z_]+$/.test(error.code) && !/^(ERR|SQLITE|UV)_/.test(error.code));
  return business
    ? { status: Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 400,
        code: error.code, message: error.message }
    : { status: 500, code: 'OPERATION_FAILED', message: '操作未完成，请重试或检查 DSH 设置。' };
}
/** Create plugin services independently of HTTP for real host and integration tests. */
export function createHostServices(ctx, directory, options = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw fail('STORAGE_UNSAFE', '插件数据目录不能是链接。');
  const career = createCareerService({ directory, generate: options.generate ?? createModelGenerator(ctx) });
  const voice = createVoiceService({ speechToText: () => ctx.get('speechToText'), speechController: () => ctx.get('speechController') });
  const config = options.config ?? {};
  const realtimeAvailable = () => ['sessions', 'sessionPersistence', 'workspaceRegistry'].every(name => Boolean(ctx.get(name)));
  const createRecorder = async ({ sessionId, interviewId, readLedger, interview }) => {
    interview ??= (await career.dispatch('state')).interviews.find(row => row.id === interviewId);
    const workspace = ctx.get('workspaceRegistry')?.get(interview?.workspaceId);
    if (!workspace) throw fail('WORKSPACE_REQUIRED', '请为面试选择可用的 DSH 工作区。');
    const recorder = createNativeSessionRecorder({ ctx, sessionId, interviewId, cwd: workspace.path, readLedger });
    return { ...recorder, async open() { const result = await recorder.open(); await workspace.attachSession(sessionId); return result; } };
  };
  const realtimeOptions = { getConfig: () => realtimeConfig(config),
    resolveCredential: async ref => (await ctx.get('credentials')?.resolve(ref))?.value,
    socketFactory: (url, { headers }) => new WebSocket(url, { headers, handshakeTimeout: 15000, maxPayload: 1024 * 1024,
      perMessageDeflate: false, followRedirects: false }),
    ...options.realtime,
  };
  const realtime = createRealtimeService({ career, createRecorder, ...realtimeOptions });
  const realtimeProbe = createRealtimeProbe({ ...realtimeOptions, ...options.realtimeProbe });
  const active = new Map(), pending = new Set(); let closed = false, materialsPromise, closing;
  const getMaterials = () => materialsPromise ??= import('./materials/index.js').then(module => module.createMaterialImporter({ directory, career }));
  const execute = async (action, input = {}, options = {}) => {
    if (closed) throw fail('PLUGIN_CLOSED', '职镜AI已停用。', 503);
    if (action === 'task.cancel') { active.get(input.requestId)?.abort(); return { cancelled: active.has(input.requestId) }; }
    const controller = new AbortController(), id = options.requestId ?? randomUUID();
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw fail('INVALID_REQUEST_ID', '操作标识无效。');
    if (active.has(id)) throw fail('REQUEST_IN_PROGRESS', '此操作正在执行。', 409);
    active.set(id, controller);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      signal.throwIfAborted();
      if (action === 'voice.catalog') return await voice.catalog();
      if (action === 'realtime.catalog') return await realtimeCatalog(ctx, config, realtimeAvailable());
      if (action === 'realtime.test') return await realtimeProbe.test(input, { signal });
      if (action === 'realtime.create') {
        if (!realtimeAvailable()) throw fail('REALTIME_HOST_UNAVAILABLE', '当前 DSH 缺少实时面试所需的会话服务。');
        const workspace = ctx.get('workspaceRegistry').get(input.workspaceId);
        if (!workspace) throw fail('WORKSPACE_REQUIRED', '请先选择 DSH 工作区。');
        const sessionId = `session-zhijing-realtime-${randomUUID()}`;
        const interview = career.realtime.create({ ...input, sessionId });
        const recorder = await createRecorder({ sessionId, interviewId: interview.id, interview,
          readLedger: () => ({ sessionId, interviewId: interview.id, entries: [] }) });
        try { await recorder.open(); } finally { await recorder.close(); }
        return interview;
      }
      if (action === 'realtime.review') return career.realtime.review(input);
      if (action.startsWith('realtime.')) throw fail('REALTIME_ACTION_INVALID', '实时通话操作无效。');
      if (['voice.settings', 'voice.save', 'voice.synthesize', 'credential.save'].includes(action)) throw fail('VOICE_MANAGED_BY_HOST', '语音识别由 DSH 管理，朗读使用设备本地声音。', 409);
      // A raw ASR record can only originate from this service's actual ASR result.
      if (action === 'interview.voiceTranscript') throw fail('VOICE_TRANSCRIPT_INTERNAL', '转写原文只能由语音识别服务保存。', 403);
      if (action === 'voice.transcribe') {
        const state = await career.dispatch('state', {}, { signal });
        const interview = state.interviews.find(row => row.id === input.interviewId);
        const question = interview?.questions.find(row => row.id === input.questionId);
        if (!interview || !question || interview.currentQuestionId !== question.id || interview.status !== 'active' || question.answer) {
          throw fail('VOICE_QUESTION_CHANGED', '当前问题已变化或面试已暂停，请重新选择本题后录音。');
        }
        const result = await voice.transcribe({ audioBase64: input.audioBase64 }, { signal });
        signal.throwIfAborted();
        const draft = await career.dispatch('interview.voiceTranscript', { interviewId: interview.id, questionId: question.id,
          transcript: result.text, providerId: result.providerId, audioSeconds: result.audioSeconds, expectedVoiceEpoch: interview.voiceEpoch ?? 0 }, { signal });
        return { ...result, speechDraftId: draft.speechDraftId };
      }
      if (action === 'material.upload') return await (await getMaterials()).upload(input, { signal });
      if (action === 'material.fetch') return await (await getMaterials()).fetchUrl(input, { signal });
      if (action === 'material.source') return await (await getMaterials()).getSource(input);
      if (action === 'material.original') {
        const result = await (await getMaterials()).getOriginal(input);
        signal.throwIfAborted(); return result;
      }
      if (action === 'document.export') {
        const { exportCareerDocument } = await import('./export.js');
        signal.throwIfAborted();
        const result = await exportCareerDocument(career, input);
        signal.throwIfAborted(); return result;
      }
      if (action === 'material.get') {
        const state = await career.dispatch('state', {}, { signal });
        const material = state.materials.find(row => row.id === input.materialId || row.versions.some(version => version.id === input.versionId));
        if (!material) throw fail('MATERIAL_NOT_FOUND', '找不到所选资料。', 404);
        if (!input.versionId) return material;
        const version = material.versions.find(row => row.id === input.versionId);
        if (!version) throw fail('VERSION_NOT_FOUND', '找不到所选资料版本。', 404);
        return version;
      }
      return await career.dispatch(action, input, { signal, sessionId: options.sessionId, modelSelection: options.modelSelection });
    } finally { active.delete(id); }
  };
  const dispatch = (action, input, options) => {
    const promise = execute(action, input, options); pending.add(promise);
    return promise.finally(() => pending.delete(promise));
  };
  return { career, voice, realtime, dispatch, original: (input, options) => dispatch('material.original', input, options), close() {
    return closing ??= (async () => {
      closed = true; for (const controller of active.values()) controller.abort();
      realtimeProbe.close();
      await realtime.close();
      // A failed optional parser import must never prevent storage cleanup.
      const results = await Promise.allSettled([materialsPromise?.then(materials => materials.close()), career.close()]);
      await Promise.allSettled([...pending]);
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Plugin cleanup failed');
    })();
  } };
}

export function apply(ctx, config = {}) {
  const directory = ctx.dshHomePath('zhijing');
  const services = createHostServices(ctx, directory, { config });
  ctx.effect(() => () => services.close(), 'zhijing service disposal');
  registerCareerTools(ctx, services.dispatch);
  registerCareerSkill(ctx);
  ctx.inject(['webServer', 'connection'], webCtx => webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: '/zhijing', handler: createRequestHandler(ctx, services) }), 'zhijing authenticated routes'));
}

export function createRequestHandler(ctx, services) {
  return async (req, res) => {
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', disconnected); res.once('close', disconnected);
    try {
      const rejection = requestRejection(ctx, req);
      if (rejection) return json(res, rejection, { ok: false, error: { code: 'UNAUTHORIZED', message: '请通过已连接的 DSH 打开职镜AI。' } });
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '请使用 POST。' } });
      const url = new URL(req.url, 'http://localhost'), body = await readJson(req, url.pathname.startsWith('/zhijing/realtime/') ? 64 * 1024 : 48 * 1024 * 1024);
      if (url.pathname === '/zhijing/realtime/open') {
        const send = async event => {
          controller.signal.throwIfAborted();
          if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          if (res.write(JSON.stringify(event) + '\n')) return;
          await new Promise((resolve, reject) => {
            const clear = () => { res.off('drain', drained); controller.signal.removeEventListener('abort', aborted); };
            const drained = () => { clear(); resolve(); }, aborted = () => { clear(); reject(fail('CANCELLED', '通话已关闭。')); };
            res.once('drain', drained); controller.signal.addEventListener('abort', aborted, { once: true });
            if (controller.signal.aborted) aborted();
          });
        };
        await services.realtime.open(body, { signal: controller.signal, onEvent: send });
        if (!res.writableEnded && !res.destroyed) res.end();
        return;
      }
      if (url.pathname === '/zhijing/realtime/control') {
        const data = await services.realtime.control(body);
        return json(res, 200, { ok: true, data });
      }
      if (url.pathname === '/zhijing/original') {
        const result = await services.original(body, { signal: controller.signal });
        if (controller.signal.aborted) return;
        res.writeHead(200, { 'content-type': result.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}` }); return res.end(result.bytes);
      }
      if (url.pathname === '/zhijing/export') {
        const result = await services.dispatch('document.export', body, { signal: controller.signal });
        if (controller.signal.aborted) return;
        res.writeHead(200, { 'content-type': result.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}` }); return res.end(result.bytes);
      }
      const action = url.pathname === '/zhijing/upload' ? 'material.upload' : url.pathname === '/zhijing/api' ? body.action : undefined;
      if (typeof action !== 'string') throw fail('NOT_FOUND', '接口不存在。', 404);
      const data = await services.dispatch(action, url.pathname === '/zhijing/upload' ? body : body.input ?? {}, { signal: controller.signal, requestId: body.requestId });
      json(res, 200, { ok: true, data });
    } catch (error) {
      // Rejecting an oversized async-iterated body can close the request stream.
      // Preserve its intentional 413 instead of reclassifying it as a cancel.
      const { status, code, message } = publicError(error, controller.signal.aborted && error?.code !== 'REQUEST_TOO_LARGE');
      if (res.headersSent) { if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify({ type: 'error', code, message }) + '\n'); return; }
      json(res, status, { ok: false, error: { code, message } });
    } finally { req.off('aborted', disconnected); res.off('close', disconnected); }
  };
}
