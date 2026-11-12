/** Browser-owned recording and playback. Only confirmed transcript text leaves this controller. */
export function encodeWave(samples) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const label = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  label(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); label(8, 'WAVE'); label(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => { const value = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); });
  return bytes;
}

function encodeBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

const publicError = error => {
  if (error?.name === 'NotAllowedError') return '麦克风或播放权限未开启，请检查浏览器与系统设置，或改用文字';
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return '未找到可用麦克风，请连接设备或改用文字';
  if (error?.voiceMessage) return error.voiceMessage;
  return '语音操作未完成，请检查语音设置后重试，或改用文字';
};
const publicErrorCode = error => error?.name === 'NotAllowedError' ? 'permission-denied'
  : error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError' ? 'device-missing'
    : typeof error?.code === 'string' ? error.code : 'voice-unavailable';
const issue = (voiceMessage, code = 'voice-unavailable') => Object.assign(new Error(voiceMessage), { voiceMessage, code });

/**
 * api exposes the Host's catalog() and transcribe(input, {signal}). Playback uses only local device voices.
 * onChange receives UI state; takeTranscript() is called only by the user's confirm action.
 * translateError({code, message}) lets the host locale own visible feedback.
 * The optional environment supplies browser primitives for controlled tests, never credentials.
 */
export function createVoiceController({ api, onChange = () => {}, translateError, transcriptionContext, language = 'zh', environment = globalThis }) {
  const context = transcriptionContext ? { interviewId: transcriptionContext.interviewId, questionId: transcriptionContext.questionId } : {};
  let state = { phase: 'idle', transcript: '', rawTranscript: '', speechDraftId: null, error: null, errorCode: null, elapsedSeconds: 0, catalog: null };
  let disposed = false;
  let generation = 0;
  let abort;
  let capture;
  let utterance;
  let tick;
  let deadline;
  const pendingCleanup = new Set();
  const getState = () => ({ ...state });
  const publish = patch => { if (!disposed) { state = { ...state, ...patch, ...(patch.error === null ? { errorCode: null } : {}) }; onChange(getState()); } };
  const report = (error, patch = {}) => {
    const code = publicErrorCode(error);
    const message = publicError(error);
    publish({ ...patch, errorCode: code, error: translateError?.({ code, message }) ?? message });
  };
  const active = id => !disposed && id === generation;
  const trackCleanup = promise => { pendingCleanup.add(promise); promise.finally(() => pendingCleanup.delete(promise)).catch(() => {}); };
  const stopTimers = () => { environment.clearInterval(tick); environment.clearTimeout(deadline); tick = undefined; deadline = undefined; };

  function releaseCapture() {
    stopTimers();
    const current = capture; capture = undefined;
    if (!current) return;
    current.stream.getTracks().forEach(track => track.stop());
    if (current.recorder.state === 'recording') {
      try { current.recorder.stop(); } catch { /* The tracks may already have ended. */ }
    }
    current.chunks.length = 0;
    if (current.context.state !== 'closed') trackCleanup(Promise.resolve(current.context.close()).catch(() => {}));
  }

  function releasePlayback() {
    if (!utterance) return;
    utterance.onend = null; utterance.onerror = null; utterance = undefined;
    // Web Speech has no per-utterance cancel; never cancel a queue we did not start.
    environment.speechSynthesis?.cancel();
  }

  function localVoice() {
    const engine = environment.speechSynthesis;
    if (!engine || !environment.SpeechSynthesisUtterance) return null;
    const prefix = String(language).toLowerCase().replaceAll('_', '-').split('-')[0];
    const voices = engine.getVoices().filter(voice => voice.localService === true && String(voice.lang).toLowerCase().replaceAll('_', '-').split('-')[0] === prefix);
    return voices.find(voice => voice.default) ?? voices[0] ?? null;
  }
  function playbackCapability() {
    try {
      const voice = localVoice();
      return { available: Boolean(voice), kind: 'device-local', language, voiceName: voice?.name ?? null,
        reasonCode: voice ? null : 'device-voice-missing' };
    } catch { return { available: false, kind: 'device-local', language, reasonCode: 'device-speech-unavailable' }; }
  }
  const voicesChanged = () => {
    publish({ catalog: { maxDurationSeconds: 120, maxAudioBytes: 4194304, asr: { available: false }, ...state.catalog, tts: playbackCapability() } });
  }

  function cancel() {
    generation += 1;
    abort?.abort(); abort = undefined;
    releaseCapture(); releasePlayback();
    publish({ phase: 'idle', elapsedSeconds: 0 });
  }

  function stopPlayback() {
    if (state.phase === 'playing' || state.phase === 'synthesizing') cancel();
    else releasePlayback();
  }

  async function refreshCatalog() {
    const id = generation;
    try {
      const catalog = await api.catalog();
      const combined = { ...catalog, tts: playbackCapability() };
      if (active(id)) publish({ catalog: combined });
      return combined;
    } catch (error) { if (active(id)) { voicesChanged(); report(error); } return null; }
  }

  async function startRecording() {
    if (disposed) return;
    cancel();
    const id = generation;
    publish({ phase: 'requesting', error: null, elapsedSeconds: 0 });
    try {
      const catalog = await refreshCatalog();
      if (!active(id)) return;
      if (!catalog?.asr.available) throw issue('请在 DSH 语音输入中启用并准备识别服务，或改用文字', 'host-asr-unavailable');
      if (!environment.navigator?.mediaDevices?.getUserMedia || !environment.MediaRecorder || !environment.AudioContext || !environment.OfflineAudioContext) {
        throw issue('此页面无法录音，请使用 DSH 桌面版或 localhost、HTTPS 页面，或改用文字');
      }
      const stream = await environment.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (!active(id)) { stream.getTracks().forEach(track => track.stop()); return; }
      let context;
      try {
        context = new environment.AudioContext();
        const recorder = new environment.MediaRecorder(stream);
        const current = { stream, context, recorder, chunks: [], started: Date.now() };
        capture = current;
        const interrupted = () => {
          if (active(id) && state.phase === 'recording') { cancel(); report(issue('录音已中断，请检查麦克风后重试，或改用文字', 'recording-interrupted')); }
        };
        stream.getTracks().forEach(track => track.addEventListener('ended', interrupted, { once: true }));
        recorder.ondataavailable = event => { if (active(id) && event.data.size) current.chunks.push(event.data); };
        recorder.onerror = interrupted;
        recorder.start();
        publish({ phase: 'recording' });
        tick = environment.setInterval(() => { if (active(id)) publish({ elapsedSeconds: Math.min(catalog.maxDurationSeconds, (Date.now() - current.started) / 1000) }); }, 250);
        deadline = environment.setTimeout(() => { if (active(id)) void stopRecording(); }, catalog.maxDurationSeconds * 1000);
      } catch (error) {
        stream.getTracks().forEach(track => track.stop());
        if (capture) releaseCapture();
        else if (context?.state !== 'closed' && context) await context.close().catch(() => {});
        throw error;
      }
    } catch (error) { if (active(id)) { releaseCapture(); report(error, { phase: 'idle' }); } }
  }

  async function stopRecording() {
    const current = capture;
    if (!current || state.phase !== 'recording') return;
    const id = generation;
    stopTimers();
    publish({ phase: 'transcribing', error: null });
    abort = new AbortController();
    const signal = abort.signal;
    try {
      await new Promise((resolve, reject) => {
        current.recorder.onstop = resolve;
        current.recorder.onerror = () => reject(issue('录音未完成，请重试或改用文字'));
        current.recorder.stop();
      });
      current.stream.getTracks().forEach(track => track.stop());
      if (!active(id)) return;
      const blob = new Blob(current.chunks, { type: current.recorder.mimeType });
      if (!blob.size) throw issue('没有录到声音，请重试或改用文字');
      const decoded = await current.context.decodeAudioData(await blob.arrayBuffer());
      if (!active(id)) return;
      const seconds = Math.min(decoded.duration, state.catalog.maxDurationSeconds);
      const count = Math.floor(seconds * 16000);
      if (count < 1 || 44 + count * 2 > state.catalog.maxAudioBytes) throw issue('录音过短或超过大小限制，请缩短回答后重试');
      const offline = new environment.OfflineAudioContext(1, count, 16000);
      const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
      const rendered = await offline.startRendering();
      if (!active(id)) return;
      const audioBase64 = encodeBase64(encodeWave(rendered.getChannelData(0)));
      releaseCapture();
      const result = await api.transcribe({ audioBase64, ...context }, { signal });
      if (!active(id)) return;
      if (typeof result?.text !== 'string' || !result.text.trim()) throw issue('未识别到文字，请重录或输入文字');
      if (transcriptionContext && (typeof result.speechDraftId !== 'string' || !result.speechDraftId)) throw issue('转写记录未保存，请重试或输入文字', 'voice-draft-missing');
      publish({ phase: 'idle', transcript: result.text, rawTranscript: result.text, speechDraftId: result.speechDraftId ?? null, elapsedSeconds: 0 });
    } catch (error) { if (active(id)) { releaseCapture(); report(error, { phase: 'idle' }); } }
  }

  async function speak(text) {
    if (disposed) return;
    cancel();
    const id = generation;
    publish({ error: null });
    try {
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw issue('朗读文字无效，请阅读文字问题', 'invalid-speech-text');
      const voice = localVoice(), engine = environment.speechSynthesis;
      if (!voice) throw issue('设备尚无当前语言的本地朗读声音，请阅读文字问题', 'device-voice-missing');
      if (engine.speaking || engine.pending) throw issue('其他朗读正在进行，请稍后重试', 'device-speech-busy');
      const speech = new environment.SpeechSynthesisUtterance(text);
      speech.voice = voice; speech.lang = voice.lang; utterance = speech;
      speech.onend = () => { if (active(id) && utterance === speech) { utterance = undefined; publish({ phase: 'idle' }); } };
      speech.onerror = () => { if (active(id) && utterance === speech) { utterance = undefined; report(issue('设备朗读未完成，请阅读文字问题', 'playback-failed'), { phase: 'idle' }); } };
      publish({ phase: 'playing' });
      engine.speak(speech);
    } catch (error) { if (active(id)) { releasePlayback(); report(error, { phase: 'idle' }); } }
  }

  const setTranscript = text => { if (typeof text === 'string') publish({ transcript: text, error: null }); };
  const takeTranscriptDraft = () => {
    if (!state.transcript.trim()) return null;
    const draft = { text: state.transcript, editedTranscript: state.transcript, rawTranscript: state.rawTranscript, speechDraftId: state.speechDraftId, ...context };
    publish({ transcript: '', rawTranscript: '', speechDraftId: null });
    return draft;
  };
  const takeTranscript = () => takeTranscriptDraft()?.text.trim() ?? '';
  const hidden = () => { if (environment.document?.hidden) cancel(); };
  const unload = () => cancel();
  environment.document?.addEventListener('visibilitychange', hidden);
  environment.addEventListener?.('pagehide', unload);
  environment.speechSynthesis?.addEventListener?.('voiceschanged', voicesChanged);
  async function dispose() {
    if (disposed) return;
    cancel(); disposed = true;
    environment.document?.removeEventListener('visibilitychange', hidden);
    environment.removeEventListener?.('pagehide', unload);
    environment.speechSynthesis?.removeEventListener?.('voiceschanged', voicesChanged);
    await Promise.allSettled(pendingCleanup);
  }
  return { getState, refreshCatalog, startRecording, stopRecording, cancel, speak, stopPlayback, setTranscript, takeTranscript, takeTranscriptDraft, dispose };
}
