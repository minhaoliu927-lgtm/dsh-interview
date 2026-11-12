/** Continuous PCM transport for an explicitly started voice call. No stored audio. */
export function createPcm16Encoder(sourceRate, targetRate = 16000) {
  if (!Number.isFinite(sourceRate) || sourceRate < targetRate || targetRate !== 16000) throw new Error('INVALID_SAMPLE_RATE');
  const ratio = sourceRate / targetRate;
  let weight = 0, sum = 0;
  return samples => {
    const values = [];
    for (const input of samples) {
      const value = Number.isFinite(input) ? Math.max(-1, Math.min(1, input)) : 0;
      let remaining = 1;
      while (remaining > 1e-9) {
        const used = Math.min(remaining, ratio - weight);
        sum += value * used; weight += used; remaining -= used;
        if (weight >= ratio - 1e-9) {
          const mean = sum / weight;
          values.push(Math.round(mean * (mean < 0 ? 32768 : 32767)));
          weight = 0; sum = 0;
        }
      }
    }
    const bytes = new Uint8Array(values.length * 2), view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setInt16(index * 2, value, true));
    return bytes;
  };
}

const workletSource = `class CareerCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input?.length) { const frame = new Float32Array(input); this.port.postMessage(frame, [frame.buffer]); }
    return true;
  }
}
registerProcessor('career-pcm-capture', CareerCapture);`;

function encodeBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function decodeBase64(text) {
  if (typeof text !== 'string' || !text.length || text.length > 262144 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error('INVALID_AUDIO');
  const binary = atob(text);
  if (binary.length % 2) throw new Error('INVALID_AUDIO');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Owns exactly one microphone and playback queue. Provider/VAD/business events live elsewhere. */
export function createRealtimeMedia({
  sendAudio, onState = () => {}, mediaDevices = globalThis.navigator?.mediaDevices,
  createAudioContext = () => new globalThis.AudioContext(),
  createCaptureNode = context => new globalThis.AudioWorkletNode(context, 'career-pcm-capture'),
  documentImpl = globalThis.document, urlApi = globalThis.URL, BlobImpl = globalThis.Blob,
  maxQueuedFrames = 32, maxPlaybackSeconds = 30, flushTimeoutMs = 1000,
} = {}) {
  if (typeof sendAudio !== 'function' || !Number.isInteger(maxQueuedFrames) || maxQueuedFrames < 1 || !Number.isFinite(maxPlaybackSeconds) || maxPlaybackSeconds <= 0 || !Number.isFinite(flushTimeoutMs) || flushTimeoutMs < 1 || flushTimeoutMs > 1000) throw new Error('INVALID_MEDIA_OPTIONS');
  let phase = 'idle', error = null, muted = false, lifetime = 0, scope = null;
  let context, stream, source, capture, silent, workletUrl, encoder;
  let partial = new Uint8Array(0), frames = [], sending = false, sequence = 0;
  let drainingPromise, finishingPromise;
  const stoppedTracks = new WeakSet();
  let playbackEpoch = 0, nextPlayAt = 0;
  const playback = new Set();
  const snapshot = () => ({ phase, muted, error, playing: playback.size > 0 });
  const publish = () => onState(snapshot());
  const detach = node => { try { node?.disconnect(); } catch { /* Already detached. */ } };
  function stopCapture() {
    if (capture) capture.port.onmessage = null;
    detach(source); detach(capture); detach(silent);
    for (const track of stream?.getTracks() ?? []) {
      if (!stoppedTracks.has(track)) { stoppedTracks.add(track); track.stop(); }
    }
  }
  function interrupt() {
    playbackEpoch++;
    for (const node of playback) { node.onended = null; try { node.stop(); } catch { /* Already ended. */ } detach(node); }
    playback.clear(); nextPlayAt = context?.currentTime || 0; publish();
    return playbackEpoch;
  }
  async function close() {
    lifetime++; scope?.abort(); scope = null; frames = []; partial = new Uint8Array(0);
    interrupt();
    if (capture) { capture.port.onmessage = null; capture.port.close?.(); }
    stopCapture();
    const oldContext = context;
    context = stream = source = capture = silent = encoder = undefined;
    if (workletUrl) { urlApi.revokeObjectURL(workletUrl); workletUrl = undefined; }
    documentImpl?.removeEventListener('visibilitychange', onVisibility);
    phase = 'closed'; publish();
    try { await oldContext?.close(); } catch { /* Resources already released. */ }
  }
  async function fail(code) { error = code; await close(); phase = 'error'; publish(); }
  function onVisibility() { if (documentImpl.hidden) void close(); }
  function drain(generation, signal) {
    if (sending) return drainingPromise;
    sending = true;
    drainingPromise = (async () => {
    try {
      while (frames.length && generation === lifetime && !signal.aborted) {
        const frame = frames.shift();
        await sendAudio({ audioBase64: encodeBase64(frame), seq: sequence++, sampleRate: 16000 }, { signal });
      }
    } catch { if (generation === lifetime && !signal.aborted) await fail('audio-transport-failed'); }
    finally { sending = false; }
    })();
    return drainingPromise;
  }
  function finishCapture() {
    if (finishingPromise) return finishingPromise;
    if (phase !== 'listening') return close();
    const generation = lifetime, signal = scope.signal;
    phase = 'finishing'; stopCapture(); interrupt();
    if (partial.length) frames.push(partial);
    partial = new Uint8Array(0);
    finishingPromise = (async () => {
      let timer;
      try {
        const drained = await Promise.race([
          drain(generation, signal).then(() => true),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), flushTimeoutMs); }),
        ]);
        if (!drained || generation !== lifetime || signal.aborted || frames.length || error) throw Object.assign(new Error('audio-flush-incomplete'), { code: 'audio-flush-incomplete' });
      } finally { clearTimeout(timer); await close(); }
    })();
    return finishingPromise;
  }
  function acceptFrame(samples, generation, signal) {
    if (generation !== lifetime || phase !== 'listening' || muted || signal.aborted) return;
    const bytes = encoder(samples), joined = new Uint8Array(partial.length + bytes.length);
    joined.set(partial); joined.set(bytes, partial.length);
    let offset = 0;
    // 100 ms, mono 16 kHz PCM16. Never accumulate an entire answer in memory.
    while (joined.length - offset >= 3200) {
      frames.push(joined.slice(offset, offset + 3200)); offset += 3200;
    }
    partial = joined.slice(offset);
    if (frames.length > maxQueuedFrames) { void fail('audio-backpressure'); return; }
    void drain(generation, signal);
  }
  async function start() {
    if (phase !== 'idle') throw new Error('MEDIA_ALREADY_STARTED');
    const generation = ++lifetime, currentScope = new AbortController(); scope = currentScope;
    phase = 'requesting'; publish();
    try {
      if (!mediaDevices?.getUserMedia) throw new Error('MICROPHONE_UNAVAILABLE');
      const ownedStream = await mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (generation !== lifetime) { ownedStream.getTracks().forEach(track => track.stop()); return; }
      stream = ownedStream; context = createAudioContext();
      if (!context.audioWorklet?.addModule) throw new Error('AUDIO_WORKLET_UNAVAILABLE');
      const ownedContext = context;
      workletUrl = urlApi.createObjectURL(new BlobImpl([workletSource], { type: 'text/javascript' }));
      await ownedContext.audioWorklet.addModule(workletUrl);
      if (generation !== lifetime) return;
      urlApi.revokeObjectURL(workletUrl); workletUrl = undefined;
      await ownedContext.resume();
      if (generation !== lifetime) return;
      encoder = createPcm16Encoder(ownedContext.sampleRate);
      source = ownedContext.createMediaStreamSource(stream); capture = createCaptureNode(ownedContext);
      silent = ownedContext.createGain(); silent.gain.value = 0;
      capture.port.onmessage = event => acceptFrame(event.data, generation, currentScope.signal);
      source.connect(capture); capture.connect(silent); silent.connect(ownedContext.destination);
      for (const track of stream.getTracks()) track.addEventListener?.('ended', () => { if (generation === lifetime && phase === 'listening') void fail('microphone-ended'); }, { once: true });
      documentImpl?.addEventListener('visibilitychange', onVisibility);
      if (documentImpl?.hidden) { await close(); return; }
      phase = 'listening'; publish();
    } catch { if (generation === lifetime) await fail('microphone-unavailable'); }
  }
  function setMuted(value) {
    if (phase !== 'listening') return;
    muted = Boolean(value); frames = []; partial = new Uint8Array(0);
    encoder = createPcm16Encoder(context.sampleRate);
    for (const track of stream.getAudioTracks()) track.enabled = !muted;
    publish();
  }
  function play({ audioBase64, sampleRate = 24000, epoch = playbackEpoch }) {
    if (!context || phase !== 'listening' || epoch !== playbackEpoch) return false;
    try {
      if (sampleRate !== 24000) throw new Error('INVALID_AUDIO_RATE');
      const bytes = decodeBase64(audioBase64), samples = bytes.length / 2;
      const startAt = Math.max(nextPlayAt, context.currentTime);
      if (startAt - context.currentTime + samples / sampleRate > maxPlaybackSeconds) throw new Error('PLAYBACK_LIMIT');
      const buffer = context.createBuffer(1, samples, sampleRate), output = buffer.getChannelData(0), input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < samples; i++) output[i] = input.getInt16(i * 2, true) / 32768;
      const node = context.createBufferSource(); node.buffer = buffer; node.connect(context.destination);
      node.onended = () => { playback.delete(node); detach(node); publish(); };
      playback.add(node); node.start(startAt); nextPlayAt = startAt + samples / sampleRate; publish();
      return true;
    } catch { void fail('invalid-playback-audio'); return false; }
  }
  return { start, close, finishCapture, setMuted, interrupt, play, snapshot, get playbackEpoch() { return playbackEpoch; } };
}
