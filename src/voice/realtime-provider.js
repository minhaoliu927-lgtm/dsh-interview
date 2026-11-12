/**
 * Host-only Qwen-Omni WebSocket adapter. No credential persistence, audio files,
 * DSH conversation writes, automatic reconnect, or built-in network transport.
 * Protocol checked 2026-11-12 against Alibaba Cloud's official references:
 * https://www.alibabacloud.com/help/en/model-studio/omni-realtime-websocket-access
 * https://www.alibabacloud.com/help/en/model-studio/client-events
 * https://www.alibabacloud.com/help/en/model-studio/server-events
 */
export class RealtimeError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.name = 'RealtimeError'; this.code = code; this.status = status;
  }
}
const error = (code, message, status) => new RealtimeError(code, message, status);
// Inspect only an allowlisted transport code/status; never expose response bodies,
// request headers, URLs, credentials, or native error messages to the Client.
function transportFailure(event) {
  const code = event?.error?.code ?? event?.code;
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return error('dns-failed', '音频服务域名解析失败，请检查业务空间和网络。', 502);
  if (['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) {
    return error('tls-failed', '无法验证音频服务的安全连接，请检查网络和系统时间。', 502);
  }
  return error('transport-failed', '语音网络连接失败', 502);
}
function handshakeFailure(status) {
  if (status === 401) return error('authentication-failed', '音频服务未接受当前密钥，请在 DSH 中更新专用音频凭据。', 502);
  if (status === 403) return error('access-denied', '当前音频凭据没有访问权限，请检查业务空间、地域和模型权限。', 502);
  if (status === 404) return error('endpoint-unavailable', '找不到音频服务，请检查业务空间、地域和模型。', 502);
  if (status === 429) return error('rate-limited', '音频服务请求受限，请检查服务额度或稍后重试。', 429);
  if (Number.isInteger(status) && status >= 500 && status <= 599) return error('provider-unavailable', '音频服务暂时不可用，请稍后重试。', 503);
  return error('connection-failed', '音频服务未接受连接，请检查宿主语音设置。', 502);
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const MODELS = new Set(['qwen3.5-omni-plus-realtime', 'qwen3.5-omni-flash-realtime', 'qwen3.8-omni-flash-realtime']);
const REGIONS = Object.freeze({ beijing: 'cn-beijing', singapore: 'ap-southeast-1' });
const DEFAULT_LIMITS = Object.freeze({
  maxChunkBytes: 32_000, maxBufferedAudioBytes: 3_840_000, maxSessionAudioBytes: 57_600_000,
  maxOutputChunkBytes: 192_000, maxOutputResponseBytes: 8_640_000, maxMessageBytes: 512_000,
  maxTextChars: 32_000, maxToolBytes: 32_000, maxEvents: 100_000, maxTurns: 512,
  maxResponses: 2048, maxToolCalls: 1024, maxSocketBufferedBytes: 256_000,
});

export function validateRealtimeConfig(config) {
  if (!object(config) || Object.keys(config).some(key => !['region', 'workspace', 'model', 'credentialRef'].includes(key))) {
    throw error('invalid-config', '语音连接仅接受区域、工作空间、模型和凭据引用');
  }
  const { region = 'beijing', workspace, model = 'qwen3.5-omni-plus-realtime', credentialRef } = config;
  if (!Object.hasOwn(REGIONS, region) || typeof workspace !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(workspace)
    || !MODELS.has(model) || !id(credentialRef)) throw error('invalid-config', '语音区域、工作空间、模型或凭据引用无效');
  return Object.freeze({ region, workspace, model, credentialRef });
}

function decodePcm(value, maximum) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maximum / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw error('invalid-audio', '音频必须是限额内的单声道 PCM16 数据');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length % 2 || bytes.length > maximum || bytes.toString('base64') !== value
    || (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE')) {
    throw error('invalid-audio', '音频必须是限额内的单声道 PCM16 数据');
  }
  return bytes.length;
}

function closeSocket(socket) {
  if (!socket) return;
  // Node's ws emits an asynchronous error when close() aborts a connecting
  // socket. Keep only a temporary error drain until its terminal close event.
  let release = () => {};
  if (socket.readyState !== 3 && typeof socket.on === 'function' && typeof socket.off === 'function') {
    const ignore = () => {};
    release = () => { socket.off('error', ignore); socket.off('close', release); };
    socket.on('error', ignore); socket.on('close', release);
  }
  try { socket.close(1000, 'Interview ended'); } catch { release(); }
  if (socket.readyState === 3) release();
}

/**
 * socketFactory(url, {headers, signal}) supplies an EventTarget/EventEmitter socket
 * with send/close. resolveCredential(ref, {signal}) resolves a secret string only
 * inside Host. The factory must not log headers; the adapter never emits them.
 * tools: [{name,description?,parameters}], an explicit per-interview whitelist.
 * onToolCall receives {name,arguments,callId,sessionId,epoch,turnId,responseId,signal}.
 * The Host must validate arguments, permissions and current business state, and
 * honour signal before committing a write. A canceled callback cannot be undone.
 * Every onEvent contains type/sessionId/epoch/turnId. Audio is raw PCM16 base64.
 */
export function createRealtimeProvider({ resolveCredential, socketFactory, onEvent = () => {}, onToolCall,
  tools = [], connectTimeoutMs = 15_000, toolTimeoutMs = 15_000, responseTimeoutMs = 180_000,
  sessionTimeoutMs = 30 * 60_000, inputFinalizationTimeoutMs = 4000, limits: overrides = {} } = {}) {
  if (typeof resolveCredential !== 'function' || typeof socketFactory !== 'function' || typeof onEvent !== 'function') {
    throw error('invalid-adapter', '语音连接需要宿主凭据和传输服务');
  }
  for (const value of [connectTimeoutMs, toolTimeoutMs, responseTimeoutMs, sessionTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 10 || value > 3_600_000) throw error('invalid-limits', '语音处理时限无效');
  }
  if (!Number.isSafeInteger(inputFinalizationTimeoutMs) || inputFinalizationTimeoutMs < 10 || inputFinalizationTimeoutMs > 5000) {
    throw error('invalid-limits', '语音收尾时限无效');
  }
  const limits = { ...DEFAULT_LIMITS };
  if (!object(overrides)) throw error('invalid-limits', '语音限额无效');
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value <= 0 || value > limits[key]) throw error('invalid-limits', '语音限额无效');
    limits[key] = value;
  }
  const whitelist = new Map();
  if (!Array.isArray(tools) || tools.length > 16) throw error('invalid-tools', '面试工具列表无效');
  for (const tool of tools) {
    if (!object(tool) || !/^zhijing_[a-z][a-z0-9_]{0,63}$/.test(tool.name ?? '') || whitelist.has(tool.name)
      || Object.keys(tool).some(key => !['name', 'description', 'parameters'].includes(key))
      || (tool.description !== undefined && (typeof tool.description !== 'string' || tool.description.length > 2000))
      || !object(tool.parameters) || tool.parameters.type !== 'object') throw error('invalid-tools', '面试工具列表无效');
    let encoded;
    try { encoded = JSON.stringify(tool); } catch { throw error('invalid-tools', '面试工具列表无效'); }
    if (encoded.length > limits.maxToolBytes) throw error('invalid-tools', '面试工具列表过大');
    whitelist.set(tool.name, JSON.parse(encoded));
  }
  if (whitelist.size && typeof onToolCall !== 'function') throw error('invalid-tools', '面试工具需要宿主处理');

  let current = null, lastEpoch = -1;
  const live = run => current === run && !run.ended;
  const snapshot = run => ({ phase: run?.phase ?? 'idle', sessionId: run?.sessionId ?? null, epoch: run?.epoch ?? null, turnId: run?.turnId ?? 0 });
  const emit = (run, type, data = {}) => {
    // Consumer errors cannot leave a transport or microphone session alive.
    try { onEvent({ ...data, type, sessionId: run.sessionId, epoch: run.epoch, turnId: data.turnId ?? run.turnId }); }
    catch { if (!run.ended) finish(run, error('consumer-failed', '语音事件处理失败', 502)); }
  };
  function finish(run, cause) {
    if (run.ended) return;
    run.ended = true; run.phase = cause ? 'error' : 'closed';
    settleInput(run, false, cause?.code ?? 'connection-closed');
    clearTimeout(run.connectTimer); clearTimeout(run.sessionTimer); clearTimeout(run.requestTimer);
    for (const response of run.responses.values()) clearTimeout(response.timer);
    for (const call of run.calls.values()) { clearTimeout(call.timer); call.controller.abort(); }
    run.controller.abort();
    for (const remove of run.listeners) remove();
    run.listeners.length = 0;
    if (run.signal && run.abort) run.signal.removeEventListener('abort', run.abort);
    closeSocket(run.socket);
    if (!run.settled) { run.settled = true; run.reject(cause ?? error('cancelled', '语音连接已关闭', 499)); }
    if (cause) emit(run, 'error', { code: cause.code, message: cause.message, status: cause.status });
    emit(run, 'closed', { reason: cause?.code ?? 'closed' });
  }
  function send(run, payload) {
    if (!live(run) || !run.socket || run.socket.readyState !== 1) throw error('not-ready', '语音连接尚未就绪', 409);
    if ((run.socket.bufferedAmount ?? 0) > limits.maxSocketBufferedBytes) {
      const cause = error('backpressure', '语音网络发送过慢，请重新连接', 503); finish(run, cause); throw cause;
    }
    try { run.socket.send(JSON.stringify({ ...payload, event_id: `zhijing_${run.epoch}_${++run.outgoing}` })); }
    catch { const cause = error('transport-failed', '语音连接发送失败', 502); finish(run, cause); throw cause; }
  }
  function readyRun() {
    if (!current || !live(current) || !current.ready) throw error('not-ready', '语音连接尚未就绪', 409);
    return current;
  }
  function interrupt(run, reason) {
    const responseId = run.activeResponseId;
    const active = run.responses.get(responseId);
    const wasGenerating = active && !active.done && !active.cancelled;
    run.responseAllowed = false; run.requestPending = false;
    clearTimeout(run.requestTimer);
    for (const response of run.responses.values()) {
      response.cancelled = true; clearTimeout(response.timer);
    }
    for (const call of run.calls.values()) { clearTimeout(call.timer); call.controller.abort(); }
    emit(run, 'interrupted', { responseId: responseId ?? null, reason });
    // VAD already cancels server generation. Sending a second cancel on speech
    // onset races with its automatic cancellation and can cancel the next turn.
    if (reason !== 'speech' && wasGenerating) {
      const eventId = `zhijing_${run.epoch}_${run.outgoing + 1}`;
      run.cancelEventIds.add(eventId);
      send(run, { type: 'response.cancel' });
    }
  }
  function turn(run, itemId, create = false) {
    if (!id(itemId)) throw error('invalid-event', '语音服务返回了无效轮次', 502);
    if (!run.items.has(itemId) && create) {
      if (run.items.size >= limits.maxTurns) throw error('session-limit', '本次语音轮次已达上限，请结束面试', 409);
      run.items.set(itemId, { turnId: ++run.turnId, started: false, stopped: false, committed: false, final: false });
    }
    return run.items.get(itemId);
  }
  function textValue(value) {
    if (typeof value !== 'string' || value.length > limits.maxTextChars) throw error('invalid-event', '语音服务文字超出限制', 502);
    return value;
  }
  function continueTools(run, response) {
    if (!live(run) || run.inputSealed || response.cancelled || !response.done || response.continued || !response.toolCount || response.pendingTools) return;
    response.continued = true; run.responseAllowed = true; run.requestPending = true;
    armResponseStartTimeout(run);
    send(run, { type: 'response.create' });
  }
  function armResponseStartTimeout(run) {
    clearTimeout(run.requestTimer);
    run.requestTimer = setTimeout(() => finish(run, error('response-timeout', '语音回复超时，请重新连接', 504)), responseTimeoutMs);
  }
  function settleInput(run, complete, reason = null) {
    const finalization = run.finalization;
    if (!finalization || finalization.settled) return;
    finalization.settled = true; clearTimeout(finalization.timer);
    const pendingCount = [...run.items.values()].filter(item => !item.final && (item.started || item.committed)).length;
    finalization.resolve({ complete, reason, pendingCount });
  }
  function checkInputFinished(run) {
    const finalization = run.finalization;
    if (!finalization || finalization.settled || finalization.waitingForVad || finalization.waitingForCommit || run.bufferedAudioBytes) return;
    const items = [...run.items.values()];
    if (items.some(item => !item.final && (item.started || item.committed))) return;
    const failed = items.some(item => item.failed);
    settleInput(run, !failed, failed ? 'transcript-incomplete' : null);
  }
  function commitRemainingInput(run) {
    const finalization = run.finalization;
    if (!live(run) || !finalization || finalization.settled) return;
    finalization.waitingForVad = false;
    if (run.bufferedAudioBytes > 0) {
      // All appends are already sealed and the VAD-off acknowledgement is
      // ordered after any auto-commit. Only a real remaining buffer is committed.
      finalization.waitingForCommit = true; finalization.throughBytes = run.audioBytes;
      send(run, { type: 'input_audio_buffer.commit' });
    }
    checkInputFinished(run);
  }
  function runTool(run, event, response) {
    if (!id(event.call_id)) throw error('invalid-event', '语音服务返回了无效工具调用', 502);
    if (run.calls.has(event.call_id)) return;
    if (run.calls.size >= limits.maxToolCalls) throw error('session-limit', '本次语音工具调用已达上限', 409);
    let args;
    if (!whitelist.has(event.name)) throw error('tool-forbidden', '语音服务请求了未授权工具', 403);
    if (typeof event.arguments !== 'string' || Buffer.byteLength(event.arguments) > limits.maxToolBytes) throw error('invalid-tool-arguments', '语音工具参数无效', 422);
    try { args = JSON.parse(event.arguments); } catch { throw error('invalid-tool-arguments', '语音工具参数无效', 422); }
    if (!object(args)) throw error('invalid-tool-arguments', '语音工具参数必须是对象', 422);
    const call = { controller: new AbortController(), timer: null, settled: false };
    run.calls.set(event.call_id, call); response.toolCount++; response.pendingTools++;
    const meta = { name: event.name, callId: event.call_id, responseId: event.response_id, turnId: response.turnId };
    emit(run, 'tool-call', { ...meta, providerEventId: event.event_id });
    const settle = (result, failure) => {
      if (call.settled) return;
      call.settled = true; clearTimeout(call.timer); response.pendingTools--;
      if (!live(run) || response.cancelled || call.controller.signal.aborted) return;
      let output;
      if (!failure) {
        try { output = JSON.stringify(result); } catch { failure = 'tool-failed'; }
        if (typeof output !== 'string' || Buffer.byteLength(output) > limits.maxToolBytes) failure = 'tool-failed';
      }
      if (failure) output = JSON.stringify({ ok: false, error: { code: failure } });
      try {
        send(run, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output } });
        emit(run, 'tool-result', { ...meta, ok: !failure, ...(failure ? { code: failure } : {}) });
        continueTools(run, response);
      } catch { /* send has already closed the failed transport. */ }
    };
    call.timer = setTimeout(() => { settle(undefined, 'tool-timeout'); call.controller.abort(); }, toolTimeoutMs);
    Promise.resolve().then(() => {
      if (!live(run) || response.cancelled || call.controller.signal.aborted) return;
      return onToolCall({ ...meta, arguments: args, sessionId: run.sessionId, epoch: run.epoch, signal: call.controller.signal });
    }).then(value => settle(value), () => settle(undefined, 'tool-failed'));
  }
  function handle(run, event) {
    if (!object(event) || typeof event.type !== 'string') throw error('invalid-event', '语音服务返回了无效事件', 502);
    if (!id(event.event_id)) throw error('invalid-event', '语音事件缺少有效标识', 502);
    if (run.events.has(event.event_id)) return;
    if (run.events.size >= limits.maxEvents) throw error('session-limit', '本次语音事件已达上限', 409);
    run.events.add(event.event_id);
    if (event.type === 'error') {
      // Only the documented cancel race, correlated to our own cancellation,
      // is harmless. Never expose provider messages, params, headers or keys.
      if (run.cancelEventIds.has(event.error?.event_id) && event.error?.code === 'response_cancel_not_active') return;
      throw error('provider-error', '语音服务拒绝了请求，请检查宿主语音设置', 502);
    }
    if (event.type === 'session.created') {
      if (run.updateSent) return;
      if (!id(event.session?.id)) throw error('invalid-event', '语音会话标识无效', 502);
      run.providerSessionId = event.session.id; run.updateSent = true; run.phase = 'configuring';
      send(run, { type: 'session.update', session: {
        modalities: ['text', 'audio'], instructions: run.instructions,
        audio: { input: { format: { type: 'pcm', sample_rate: 16000 } }, output: { format: { type: 'pcm', sample_rate: 24000 } } },
        input_audio_format: 'pcm', output_audio_format: 'pcm',
        input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
        turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800 },
        enable_search: false, tools: [...whitelist.values()].map(tool => ({ type: 'function', function: tool })),
      } });
      run.instructions = ''; return;
    }
    if (event.type === 'session.updated') {
      if (run.ready && run.finalization?.waitingForVad) {
        if (event.session?.id !== run.providerSessionId || event.session.turn_detection !== null) {
          throw error('invalid-session', '语音服务未确认停止自动问答', 502);
        }
        commitRemainingInput(run); return;
      }
      if (!run.updateSent || run.ready) return;
      const session = event.session;
      if (!object(session) || session.id !== run.providerSessionId || (session.model && session.model !== run.config.model)
        || (session.input_audio_format && session.input_audio_format !== 'pcm')
        || (session.output_audio_format && session.output_audio_format !== 'pcm')
        || (session.audio?.input?.format?.sample_rate && session.audio.input.format.sample_rate !== 16000)
        || (session.audio?.output?.format?.sample_rate && session.audio.output.format.sample_rate !== 24000)) {
        throw error('invalid-session', '语音服务未确认所需音频设置', 502);
      }
      run.ready = true; run.phase = 'ready'; clearTimeout(run.connectTimer);
      emit(run, 'ready', { inputSampleRate: 16000, outputSampleRate: 24000, format: 'pcm16', channels: 1 });
      if (live(run)) { run.settled = true; run.resolve(snapshot(run)); }
      return;
    }
    if (!run.ready) return;
    const base = { providerEventId: event.event_id, ...(id(event.item_id) ? { itemId: event.item_id } : {}) };
    if (event.type === 'input_audio_buffer.speech_started') {
      const item = turn(run, event.item_id, true);
      if (item.started || item.committed || item.turnId !== run.turnId) return;
      item.started = true; interrupt(run, 'speech');
      emit(run, 'speech-started', { ...base, turnId: item.turnId }); return;
    }
    if (event.type === 'input_audio_buffer.speech_stopped' || event.type === 'input_audio_buffer.committed') {
      const item = turn(run, event.item_id, true);
      const committed = event.type === 'input_audio_buffer.committed';
      if (item[committed ? 'committed' : 'stopped']) return;
      item[committed ? 'committed' : 'stopped'] = true;
      if (!committed && Number.isFinite(event.audio_end_ms) && event.audio_end_ms >= 0) {
        item.audioEndBytes = Math.min(run.audioBytes, Math.floor(event.audio_end_ms * 32));
      }
      if (committed) {
        const finalization = run.finalization;
        const throughBytes = finalization?.waitingForCommit ? finalization.throughBytes : item.audioEndBytes ?? run.audioBytes;
        run.committedAudioBytes = Math.max(run.committedAudioBytes, throughBytes);
        run.bufferedAudioBytes = Math.max(0, run.audioBytes - run.committedAudioBytes);
        if (finalization?.waitingForCommit) finalization.waitingForCommit = false;
        if (item.turnId === run.turnId && !run.inputSealed) { run.responseAllowed = true; armResponseStartTimeout(run); }
      }
      emit(run, committed ? 'input-committed' : 'speech-stopped', { ...base, turnId: item.turnId }); checkInputFinished(run); return;
    }
    if (event.type.startsWith('conversation.item.input_audio_transcription.')) {
      const item = turn(run, event.item_id);
      if (!item || item.final) return;
      if (event.type.endsWith('.failed')) { item.final = true; item.failed = true; emit(run, 'input-transcript-failed', { ...base, turnId: item.turnId, code: 'transcription-failed' }); }
      else if (event.type.endsWith('.completed')) {
        item.final = true; emit(run, 'input-transcript', { ...base, turnId: item.turnId, text: textValue(event.transcript), source: 'provider-transcript' });
      } else if (event.type.endsWith('.delta')) {
        const text = textValue(event.text), stash = textValue(event.stash);
        emit(run, 'input-transcript-delta', { ...base, turnId: item.turnId, text, stash, preview: textValue(text + stash), replace: true });
      }
      checkInputFinished(run); return;
    }
    if (event.type === 'response.created') {
      const responseId = event.response?.id;
      if (!id(responseId)) throw error('invalid-event', '语音服务回复标识无效', 502);
      if (run.responses.has(responseId)) return;
      if (run.responses.size >= limits.maxResponses) throw error('session-limit', '本次语音回复已达上限', 409);
      const response = { turnId: run.turnId, cancelled: run.inputSealed || !run.responseAllowed, done: false, audioBytes: 0,
        toolCount: 0, pendingTools: 0, continued: false, finals: new Set(), timer: null };
      run.responses.set(responseId, response);
      if (response.cancelled) {
        if (run.inputSealed) {
          run.cancelEventIds.add(`zhijing_${run.epoch}_${run.outgoing + 1}`);
          send(run, { type: 'response.cancel' });
        }
        return;
      }
      run.activeResponseId = responseId; run.requestPending = false;
      clearTimeout(run.requestTimer);
      response.timer = setTimeout(() => finish(run, error('response-timeout', '语音回复超时，请重新连接', 504)), responseTimeoutMs);
      emit(run, 'response-started', { ...base, responseId, turnId: response.turnId }); return;
    }
    const responseId = event.response_id ?? event.response?.id;
    const response = run.responses.get(responseId);
    if (!response || response.cancelled || response.done) return;
    const meta = { ...base, responseId, turnId: response.turnId };
    if (event.type === 'response.done') {
      response.done = true; clearTimeout(response.timer);
      const status = ['completed', 'cancelled', 'failed', 'incomplete'].includes(event.response?.status) ? event.response.status : 'unknown';
      if (status !== 'completed') { response.cancelled = true; for (const call of run.calls.values()) call.controller.abort(); }
      emit(run, 'response-done', { ...meta, status }); continueTools(run, response); return;
    }
    if (event.type === 'response.function_call_arguments.done') { runTool(run, event, response); return; }
    // Only complete arguments are executable; streamed argument fragments are ignored.
    if (event.type === 'response.audio.delta') {
      if (response.finals.has(`audio-done:${event.item_id ?? ''}:${event.content_index ?? 0}`)) return;
      response.audioBytes += decodePcm(event.delta, limits.maxOutputChunkBytes);
      if (response.audioBytes > limits.maxOutputResponseBytes) throw error('audio-limit', '语音回复超过时长限制', 413);
      emit(run, 'audio', { ...meta, audioBase64: event.delta, format: 'pcm16', sampleRate: 24000, channels: 1 }); return;
    }
    const outputs = { 'response.audio_transcript.delta': 'output-transcript-delta', 'response.text.delta': 'output-transcript-delta',
      'response.audio_transcript.done': 'output-transcript', 'response.text.done': 'output-transcript', 'response.audio.done': 'audio-done' };
    const type = outputs[event.type];
    if (!type) return;
    if (type.endsWith('-delta') && response.finals.has(`output-transcript:${event.item_id ?? ''}:${event.content_index ?? 0}`)) return;
    if (!event.type.endsWith('.delta')) {
      const key = `${type}:${event.item_id ?? ''}:${event.content_index ?? 0}`;
      if (response.finals.has(key)) return;
      response.finals.add(key);
    }
    emit(run, type, { ...meta, ...(type.endsWith('-delta') ? { delta: textValue(event.delta) }
      : type === 'output-transcript' ? { text: textValue(event.transcript ?? event.text) } : {}) });
  }
  async function connect({ config, sessionId, epoch, instructions, signal } = {}) {
    const selected = validateRealtimeConfig(config);
    if (!id(sessionId) || !Number.isSafeInteger(epoch) || epoch < 0 || epoch <= lastEpoch
      || (signal !== undefined && !(signal instanceof AbortSignal))
      || typeof instructions !== 'string' || !instructions.trim() || instructions.length > 32_000) throw error('invalid-session', '语音会话参数或连接代次无效');
    if (current && live(current)) throw error('already-connected', '当前已有语音连接', 409);
    lastEpoch = epoch;
    const run = { config: selected, sessionId, epoch, instructions, signal, phase: 'connecting', controller: new AbortController(),
      ended: false, ready: false, updateSent: false, turnId: 0, outgoing: 0, lastSeq: -1, bufferedAudioBytes: 0, audioBytes: 0, committedAudioBytes: 0,
      responseAllowed: true, requestPending: false, events: new Set(), cancelEventIds: new Set(), items: new Map(), responses: new Map(), calls: new Map(), listeners: [] };
    current = run;
    const pending = new Promise((resolve, reject) => { run.resolve = resolve; run.reject = reject; });
    run.abort = () => finish(run, error('cancelled', '语音连接已取消', 499));
    if (signal?.aborted) { run.abort(); return pending; }
    signal?.addEventListener('abort', run.abort, { once: true });
    run.connectTimer = setTimeout(() => finish(run, error('connect-timeout', '语音连接超时，请检查宿主语音设置', 504)), connectTimeoutMs);
    run.sessionTimer = setTimeout(() => finish(run, error('session-timeout', '本次语音连接已达时限', 408)), sessionTimeoutMs);
    void (async () => {
      let secret;
      try {
        secret = await resolveCredential(selected.credentialRef, { signal: run.controller.signal });
        if (!live(run)) return;
        if (typeof secret !== 'string' || !secret || secret.length > 8192 || /[\r\n]/.test(secret)) throw error('credential-unavailable', '宿主语音凭据不可用', 409);
        const url = `wss://${selected.workspace}.${REGIONS[selected.region]}.maas.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(selected.model)}`;
        const socket = await socketFactory(url, { headers: { Authorization: `Bearer ${secret}` }, signal: run.controller.signal });
        secret = undefined;
        if (!live(run)) { closeSocket(socket); return; }
        if (!socket || typeof socket.send !== 'function' || typeof socket.close !== 'function') throw error('invalid-adapter', '宿主语音传输不可用', 502);
        run.socket = socket;
        const listen = (name, handler) => {
          if (typeof socket.addEventListener === 'function' && typeof socket.removeEventListener === 'function') {
            socket.addEventListener(name, handler); run.listeners.push(() => socket.removeEventListener(name, handler));
          } else if (typeof socket.on === 'function' && typeof socket.off === 'function') {
            socket.on(name, handler); run.listeners.push(() => socket.off(name, handler));
          } else throw error('invalid-adapter', '宿主语音传输事件不可用', 502);
        };
        listen('message', data => {
          if (!live(run)) return;
          try {
            const raw = object(data) && 'data' in data ? data.data : data;
            const message = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) || raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : null;
            if (message === null || Buffer.byteLength(message) > limits.maxMessageBytes) throw error('invalid-event', '语音服务事件超过限制', 502);
            let event;
            try { event = JSON.parse(message); } catch { throw error('invalid-event', '语音服务事件格式无效', 502); }
            handle(run, event);
          } catch (cause) { finish(run, cause instanceof RealtimeError ? cause : error('invalid-event', '语音服务事件无效', 502)); }
        });
        // Node ws exposes HTTP upgrade failures only through EventEmitter,
        // even when it also implements the browser-style EventTarget methods.
        if (typeof socket.on === 'function' && typeof socket.off === 'function') {
          const rejected = (_request, response) => { if (live(run)) finish(run, handshakeFailure(response?.statusCode)); };
          socket.on('unexpected-response', rejected);
          run.listeners.push(() => socket.off('unexpected-response', rejected));
        }
        listen('error', event => { if (live(run)) finish(run, transportFailure(event)); });
        listen('close', () => { if (live(run)) finish(run, error('connection-closed', '语音连接已断开，请手动重新连接', 502)); });
        if (socket.readyState === 3) finish(run, error('connection-closed', '语音连接已断开', 502));
      } catch (cause) {
        if (live(run)) finish(run, cause instanceof RealtimeError ? cause : error('connection-failed', '无法连接语音服务，请检查宿主语音设置', 502));
      } finally { secret = undefined; }
    })();
    return pending;
  }
  return {
    connect,
    getState: () => snapshot(current),
    appendAudio({ audioBase64, seq } = {}) {
      const run = readyRun();
      if (run.inputSealed) throw error('input-finished', '语音正在收尾，不能继续发送录音', 409);
      if (!Number.isSafeInteger(seq) || seq < 0) throw error('invalid-sequence', '音频分片编号无效');
      if (seq <= run.lastSeq) return false;
      const size = decodePcm(audioBase64, limits.maxChunkBytes);
      if (run.bufferedAudioBytes + size > limits.maxBufferedAudioBytes || run.audioBytes + size > limits.maxSessionAudioBytes) {
        const cause = error('audio-limit', '本次语音输入超过时长限制', 413); finish(run, cause); throw cause;
      }
      send(run, { type: 'input_audio_buffer.append', audio: audioBase64 });
      run.lastSeq = seq; run.bufferedAudioBytes += size; run.audioBytes += size;
      return true;
    },
    requestResponse() {
      const run = readyRun(), active = run.responses.get(run.activeResponseId);
      if (run.inputSealed) return false;
      if (run.requestPending || (active && !active.done && !active.cancelled)) return false;
      run.responseAllowed = true; run.requestPending = true; armResponseStartTimeout(run); send(run, { type: 'response.create' }); return true;
    },
    finishInput() {
      const run = readyRun();
      if (run.finalization) return run.finalization.promise;
      const finalization = { waitingForVad: run.bufferedAudioBytes > 0, waitingForCommit: false, settled: false };
      finalization.promise = new Promise(resolve => { finalization.resolve = resolve; });
      run.finalization = finalization; run.inputSealed = true;
      finalization.timer = setTimeout(() => settleInput(run, false, 'transcript-incomplete'), inputFinalizationTimeoutMs);
      try {
        interrupt(run, 'finish');
        if (finalization.waitingForVad) send(run, { type: 'session.update', session: { turn_detection: null } });
        else checkInputFinished(run);
      } catch (cause) { settleInput(run, false, cause instanceof RealtimeError ? cause.code : 'transcript-incomplete'); }
      return finalization.promise;
    },
    cancelResponse() { const run = readyRun(); interrupt(run, 'user'); },
    close() { if (current) finish(current); },
  };
}
