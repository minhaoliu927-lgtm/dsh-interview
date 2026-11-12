/** Use only the Host's published speech capability. No endpoints, credentials or private settings. */
export class VoiceError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'VoiceError'; this.code = code; this.status = status; }
}
const defaults = Object.freeze({ maxDurationSeconds: 120, maxAudioBytes: 4 * 1024 * 1024 });
const fail = (code, message, status) => { throw new VoiceError(code, message, status); };
const service = value => typeof value === 'function' ? value() : value;

/** Validate the canonical 16 kHz mono PCM16 format before delegating to DSH. */
export function decodeRecording(encoded, limits = defaults) {
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(limits.maxAudioBytes / 3) * 4) fail('invalid-audio', '录音过大或格式无效');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 46 || bytes.length > limits.maxAudioBytes || bytes.toString('base64') !== encoded) fail('invalid-audio', '录音过大或格式无效');
  const marker = (start, end) => bytes.toString('ascii', start, end);
  if (marker(0, 4) !== 'RIFF' || marker(8, 12) !== 'WAVE' || marker(12, 16) !== 'fmt ' || marker(36, 40) !== 'data'
    || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1
    || bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== 16000 || bytes.readUInt32LE(28) !== 32000
    || bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16 || bytes.readUInt32LE(40) !== bytes.length - 44 || (bytes.length - 44) % 2) {
    fail('invalid-audio', '录音必须为 16 kHz 单声道 PCM16 WAV');
  }
  const audioSeconds = (bytes.length - 44) / 32000;
  if (audioSeconds > limits.maxDurationSeconds) fail('invalid-audio', '录音超过时长限制');
  return { bytes, audioSeconds };
}

export function createVoiceService({ speechController, speechToText, requestTimeoutMs = 90_000 } = {}) {
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 10 || requestTimeoutMs > 300_000) fail('invalid-limits', '语音处理时限无效');
  function host() {
    const controller = service(speechController), registry = service(speechToText);
    const remote = typeof controller?.catalog === 'function' && typeof controller?.transcribe === 'function';
    if (!remote && !(typeof registry?.snapshot === 'function' && typeof registry?.resolve === 'function' && typeof registry?.transcribe === 'function')) return null;
    const snapshot = remote ? controller.catalog() : registry.snapshot();
    const provider = snapshot.providers?.find(row => row.id === snapshot.selection?.providerId);
    const limits = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const value = snapshot[key];
      if (value !== undefined) {
        if (!Number.isFinite(value) || value <= 0) fail('host-unavailable', 'DSH 语音限制无效');
        limits[key] = Math.min(defaults[key], value);
      }
    }
    return { controller, registry, remote, snapshot, provider, limits };
  }
  const available = state => Boolean(state?.provider && ['ready', 'standby', 'waking'].includes(state.provider.preparation?.phase ?? 'ready'));
  async function catalog() {
    let state;
    try { state = host(); } catch { state = null; }
    const ready = available(state);
    return { ...(state?.limits ?? defaults), asr: { kind: 'host', available: ready,
      providerId: state?.snapshot.selection?.providerId ?? null, language: state?.snapshot.selection?.language ?? null,
      reasonCode: ready ? null : !state ? 'host-asr-unavailable' : !state.provider ? 'host-asr-provider-unavailable' : 'host-asr-not-ready',
      providers: (state?.snapshot.providers ?? []).map(row => ({ id: row.id, name: row.name ?? row.id, location: row.location,
        languages: row.languages ?? [], phase: row.preparation?.phase ?? 'ready' })) },
      tts: { available: false, kind: null, reasonCode: 'no-host-tts-service' } };
  }
  async function transcribe(input, { signal } = {}) {
    const deadline = AbortSignal.timeout(requestTimeoutMs), scoped = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let abort;
    const cancelled = new Promise((_resolve, reject) => { abort = () => reject(new Error('Speech cancelled')); });
    scoped.addEventListener('abort', abort, { once: true });
    try {
      scoped.throwIfAborted();
      return await Promise.race([cancelled, (async () => {
        if (!input || Object.keys(input).some(key => key !== 'audioBase64')) fail('host-managed', '语音识别使用 DSH 当前服务和语言设置');
        const state = host();
        if (!available(state)) fail('host-asr-unavailable', '请在 DSH 语音输入中启用并准备识别服务', 409);
        const { bytes, audioSeconds } = decodeRecording(input.audioBase64, state.limits);
        const selection = state.snapshot.selection;
        const result = state.remote
          ? await state.controller.transcribe({ audioBase64: input.audioBase64, providerId: selection.providerId, language: selection.language }, scoped)
          : await state.registry.transcribe(state.registry.resolve({ audio: bytes, providerId: selection.providerId, language: selection.language }), scoped);
        scoped.throwIfAborted();
        if (typeof result?.text !== 'string' || !result.text.trim() || result.text.length > 16_000) fail('empty-transcript', '未识别到有效文字，请重录或输入文字', 422);
        return { text: result.text, audioSeconds, providerId: selection.providerId };
      })()]);
    } catch (error) {
      if (signal?.aborted) fail('cancelled', '已取消语音操作', 499);
      if (deadline.aborted) fail('timeout', '语音处理超时，请重试或改用文字', 504);
      if (error instanceof VoiceError) throw error;
      fail('host-unavailable', 'DSH 语音识别暂时不可用，请检查宿主设置或改用文字', 502);
    } finally { scoped.removeEventListener('abort', abort); }
  }
  return { catalog, transcribe };
}
