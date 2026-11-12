import React from 'react';
import css from './styles.css';
import { Button, createSubmissionGuard } from './components.jsx';
import { createApi } from './api.js';

export const REALTIME_MODELS = ['qwen3.5-omni-plus-realtime', 'qwen3.5-omni-flash-realtime', 'qwen3.8-omni-flash-realtime'];
const REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WORKSPACE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const unavailable = Object.freeze({ status: 'unavailable', writable: false });
const unavailableSource = { getSnapshot: () => unavailable, subscribe: () => () => {} };

export function realtimeSettingsValue(value = {}) {
  return { realtimeEnabled: value.realtimeEnabled === true, realtimeRegion: value.realtimeRegion ?? 'beijing',
    realtimeWorkspace: value.realtimeWorkspace ?? '', realtimeModel: value.realtimeModel ?? REALTIME_MODELS[0],
    realtimeCredential: value.realtimeCredential ?? 'ZHIJING_REALTIME_API_KEY' };
}

/** Public Host configuration and write-only credentials; never resolve/read a secret. */
export function createRealtimeSettingsActions(form, credentials, api) {
  const request = (...args) => (api ??= createApi()).request(...args);
  const currentRef = () => realtimeSettingsValue(form?.getSnapshot()?.value).realtimeCredential;
  const describeCredential = async ref => {
    if (form?.getSnapshot()?.status !== 'ready' || !credentials?.describe || !REF.test(ref) || ref !== currentRef()) return { status: 'unavailable' };
    try {
      const result = await credentials.describe([ref]);
      const info = result.ok && result.value?.[ref];
      return info ? { status: 'ready', configured: info.configured === true, writable: info.writable === true } : { status: 'failed' };
    } catch { return { status: 'failed' }; }
  };
  return {
    hooks: { realtimeSettings: form ?? unavailableSource },
    async saveSettings(value, revision) {
      if (!form || form.getSnapshot().status !== 'ready' || !form.getSnapshot().writable) return 'readonly';
      const next = realtimeSettingsValue(value);
      if (!['beijing', 'singapore'].includes(next.realtimeRegion) || !REALTIME_MODELS.includes(next.realtimeModel)
        || typeof next.realtimeWorkspace !== 'string' || (next.realtimeEnabled && !WORKSPACE.test(next.realtimeWorkspace)) || !REF.test(next.realtimeCredential)) return 'invalid';
      try {
        return await form.mutate(Object.entries(next).map(([field, value]) => ({ op: 'set', path: [field], value })), revision) ? 'saved' : 'conflict';
      } catch { return 'failed'; }
    },
    describeCredential,
    async testAudio(options) {
      const snapshot = form?.getSnapshot(), settings = realtimeSettingsValue(snapshot?.value);
      if (snapshot?.status !== 'ready' || !settings.realtimeEnabled || !WORKSPACE.test(settings.realtimeWorkspace)) {
        throw Object.assign(new Error('Audio settings unavailable'), { code: 'not-configured' });
      }
      const info = await describeCredential(settings.realtimeCredential);
      options.signal.throwIfAborted();
      if (info.status !== 'ready' || !info.configured) throw Object.assign(new Error('Audio credential unavailable'), { code: 'credential-unavailable' });
      return request('realtime.test', {}, options);
    },
    cancelAudio: ({ requestId, signal }) => request('task.cancel', { requestId }, { signal }),
    async storeCredential(ref, value) {
      if (typeof value !== 'string' || !value.trim() || !credentials?.set || ref !== currentRef()) return 'invalid';
      const info = await describeCredential(ref);
      if (info.status !== 'ready') return 'failed';
      if (!info.writable) return 'readonly';
      try { return (await credentials.set(ref, value)).ok ? 'saved' : 'failed'; }
      catch { return 'failed'; }
    },
  };
}

const PROBE_ERRORS = {
  BUSY: 'rtProbeBusy', 'probe-timeout': 'rtProbeTimeout', 'connect-timeout': 'rtProbeTimeout', 'response-timeout': 'rtProbeTimeout',
  'not-configured': 'rtProbeConfigure', 'invalid-config': 'rtProbeConfigure', 'credential-unavailable': 'rtProbeCredential',
  'probe-no-audio': 'rtProbeNoAudio', 'invalid-audio': 'rtProbeNoAudio', 'probe-no-transcript': 'rtProbeNoTranscript',
  'authentication-failed': 'rtProbeAuthentication', 'access-denied': 'rtProbeAccess', 'endpoint-unavailable': 'rtProbeEndpoint',
  'rate-limited': 'rtProbeRateLimit', 'provider-unavailable': 'rtProbeProvider', 'dns-failed': 'rtProbeNetwork', 'tls-failed': 'rtProbeTls',
  cancelled: 'rtProbeCancelled',
};

function createProbeRequestId() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return `realtime_test_${crypto.randomUUID()}`;
  if (typeof crypto?.getRandomValues !== 'function') throw new Error('Secure request identity unavailable');
  return `realtime_test_${[...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

/** Owns this panel's test request and temporary audio; no microphone or credential reads. */
export function createRealtimeProbe({ testAudio, cancelAudio }, {
  onChange, urlApi = globalThis.URL, makeAudio = url => new Audio(url),
  setTimer = setTimeout, clearTimer = clearTimeout,
  makeRequestId = createProbeRequestId,
} = {}) {
  let task, audio, audioUrl, disposed = false, playbackEpoch = 0, state = { status: 'idle', playing: false };
  const publish = next => { state = next; if (!disposed) onChange?.(next); };
  const stop = () => {
    playbackEpoch += 1;
    if (audio) { audio.pause(); audio.currentTime = 0; }
    if (state.playing) publish({ ...state, playing: false });
  };
  const release = () => {
    stop();
    if (audio) { audio.onended = null; audio.onerror = null; audio.removeAttribute('src'); audio.load(); audio = null; }
    if (audioUrl) { urlApi.revokeObjectURL(audioUrl); audioUrl = null; }
  };
  const cancelRequest = () => {
    if (!task) return;
    const previous = task; task = null; clearTimer(previous.timer); previous.controller.abort();
    const controller = new AbortController(), timer = setTimer(() => controller.abort(), 3000);
    try { Promise.resolve(cancelAudio({ requestId: previous.requestId, signal: controller.signal })).catch(() => {}).finally(() => clearTimer(timer)); }
    catch { clearTimer(timer); }
  };
  const clear = () => { cancelRequest(); release(); publish({ status: 'idle', playing: false }); };
  return {
    async start() {
      if (disposed || task) return;
      release();
      let current;
      try { current = { requestId: makeRequestId(), controller: new AbortController() }; }
      catch { publish({ status: 'failed', playing: false, message: 'rtProbeFailed' }); return; }
      task = current;
      publish({ status: 'running', playing: false });
      current.timer = setTimer(() => {
        if (task !== current) return;
        cancelRequest(); publish({ status: 'failed', playing: false, message: 'rtProbeTimeout' });
      }, 30000);
      try {
        const result = await testAudio({ requestId: current.requestId, signal: current.controller.signal });
        if (disposed || task !== current) return;
        const encoded = result?.audio?.base64, times = result?.latencyMs;
        if (result?.ok !== true || result.checks?.handshake !== true || result.checks?.audio !== true || result.checks?.transcript !== true
          || result.audio.mimeType !== 'audio/wav' || typeof encoded !== 'string' || !encoded.length || encoded.length > 256 * 1024
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || !times || !['ready', 'firstAudio', 'total'].every(key => Number.isFinite(times[key]) && times[key] >= 0)) {
          throw new Error('Invalid audio test result');
        }
        const decoded = atob(encoded);
        if (decoded.length < 44 || decoded.slice(0, 4) !== 'RIFF' || decoded.slice(8, 12) !== 'WAVE') throw new Error('Invalid test audio');
        const bytes = Uint8Array.from(decoded, value => value.charCodeAt(0));
        audioUrl = urlApi.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
        publish({ status: 'succeeded', playing: false, latencyMs: { ready: Math.round(times.ready), firstAudio: Math.round(times.firstAudio), total: Math.round(times.total) } });
      } catch (error) {
        if (!disposed && task === current) publish({ status: 'failed', playing: false,
          message: Object.hasOwn(PROBE_ERRORS, error?.code) ? PROBE_ERRORS[error.code] : 'rtProbeFailed' });
      } finally {
        clearTimer(current.timer); if (task === current) task = null;
      }
    },
    cancel() { if (!task) return; cancelRequest(); release(); publish({ status: 'cancelled', playing: false, message: 'rtProbeCancelled' }); },
    clear,
    async play() {
      if (disposed || !audioUrl || state.status !== 'succeeded' || state.playing) return;
      const epoch = ++playbackEpoch;
      try {
        if (!audio) {
          const player = makeAudio(audioUrl); audio = player;
          player.onended = () => { if (disposed || audio !== player) return; playbackEpoch += 1; publish({ ...state, playing: false }); };
          player.onerror = () => { if (disposed || audio !== player) return; playbackEpoch += 1; publish({ ...state, playing: false, playbackMessage: 'rtProbePlaybackFailed' }); };
        }
        publish({ ...state, playing: true, playbackMessage: undefined });
        await audio.play();
      } catch {
        if (!disposed && epoch === playbackEpoch) publish({ ...state, playing: false, playbackMessage: 'rtProbePlaybackFailed' });
      }
    },
    stop,
    dispose() { disposed = true; cancelRequest(); release(); },
  };
}

export function registerRealtimeSettings(ctx, namespace) {
  let binding;
  return ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: 'dsh-interview', locale: namespace,
    inject: () => {
      const form = ctx.get('configForms')?.get('dsh-interview'), credentials = ctx.get('remote.credentials') ?? ctx.get('remote')?.credentials;
      if (!binding || binding.form !== form || binding.credentials !== credentials) binding = { form, credentials, actions: createRealtimeSettingsActions(form, credentials) };
      return binding.actions;
    },
  }, RealtimeSettings));
}

export function RealtimeSettings({ t, useRealtimeSettings, saveSettings, describeCredential, storeCredential, testAudio, cancelAudio }) {
  const snapshot = useRealtimeSettings(value => value), base = realtimeSettingsValue(snapshot.value);
  const [draft, setDraft] = React.useState(null), [revision, setRevision] = React.useState(undefined);
  const [saving, setSaving] = React.useState(false), [notice, setNotice] = React.useState(null);
  const [credential, setCredential] = React.useState({ status: 'loading' }), [key, setKey] = React.useState('');
  const [keySaving, setKeySaving] = React.useState(false), [keyNotice, setKeyNotice] = React.useState(null);
  const [refresh, setRefresh] = React.useState(0);
  const [probe, setProbe] = React.useState({ status: 'idle', playing: false }), probeRef = React.useRef(null);
  const settingsGuard = React.useRef(createSubmissionGuard()), credentialGuard = React.useRef(createSubmissionGuard());
  const value = draft ?? base, savedRef = base.realtimeCredential;
  const active = React.useRef(true);
  React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  React.useEffect(() => {
    const controller = createRealtimeProbe({ testAudio, cancelAudio }, { onChange: setProbe }); probeRef.current = controller;
    return () => { controller.dispose(); if (probeRef.current === controller) probeRef.current = null; };
  }, [testAudio, cancelAudio]);
  React.useEffect(() => { probeRef.current?.clear(); }, [snapshot.status, snapshot.revision, base.realtimeEnabled,
    base.realtimeRegion, base.realtimeWorkspace, base.realtimeModel, savedRef, refresh]);
  React.useEffect(() => {
    let current = true; setKey(''); setKeyNotice(null); setCredential({ status: 'loading' });
    if (snapshot.status === 'ready') void describeCredential(savedRef).then(info => { if (current) setCredential(info); });
    else setCredential({ status: 'unavailable' });
    return () => { current = false; };
  }, [savedRef, snapshot.status, refresh, describeCredential]);
  const edit = (field, next) => {
    probeRef.current?.clear();
    if (!draft) setRevision(snapshot.revision);
    setDraft(previous => ({ ...(previous ?? base), [field]: next })); setNotice(null);
  };
  const disabled = snapshot.status !== 'ready' || !snapshot.writable || saving || keySaving;
  const pendingRef = value.realtimeCredential !== savedRef;
  const unsaved = draft !== null || key.length > 0;
  const testDisabled = snapshot.status !== 'ready' || saving || keySaving || unsaved || !base.realtimeEnabled
    || !WORKSPACE.test(base.realtimeWorkspace) || credential.status !== 'ready' || !credential.configured || probe.status === 'running';
  const message = (prefix, result) => `${prefix}${result[0].toUpperCase()}${result.slice(1)}`;
  return <section className="zj" data-zhijing-realtime-settings="" style={{ display: 'block', height: 'auto', minHeight: 0, maxWidth: 720 }}>
    <style>{css}</style><h3>{t('realtimeSettings')}</h3><p className="zj-subtle">{t('rtSettingsNote')}</p>
    <p className="zj-subtle">{t('rtSettingsPrivacy')}</p>
    {snapshot.status !== 'ready' && <p role="status">{t(snapshot.status === 'loading' ? 'loading' : 'rtSettingsUnavailable')}</p>}
    <form className="zj-form" onSubmit={event => {
      event.preventDefault(); if (disabled) return;
      void settingsGuard.current(async () => {
        probeRef.current?.clear();
        setSaving(true); const result = await saveSettings(value, draft ? revision : snapshot.revision);
        if (active.current) { setSaving(false); setNotice(message('rtSettings', result)); if (result === 'saved') setDraft(null); }
      });
    }}>
      <label>{t('rtSettingsEnabled')}<select disabled={disabled} value={String(value.realtimeEnabled)} onChange={e => edit('realtimeEnabled', e.target.value === 'true')}>
        <option value="false">{t('rtSettingsOff')}</option><option value="true">{t('rtSettingsOn')}</option>
      </select></label>
      <label>{t('rtSettingsRegion')}<select disabled={disabled} value={value.realtimeRegion} onChange={e => edit('realtimeRegion', e.target.value)}>
        <option value="beijing">{t('rtSettingsBeijing')}</option><option value="singapore">{t('rtSettingsSingapore')}</option>
      </select></label>
      <label>{t('rtSettingsWorkspace')}<input disabled={disabled} required={value.realtimeEnabled} maxLength={64} value={value.realtimeWorkspace}
        onChange={e => edit('realtimeWorkspace', e.target.value.trim())} autoComplete="off" placeholder={t('rtSettingsWorkspaceHint')}/></label>
      <label>{t('rtSettingsModel')}<select disabled={disabled} value={value.realtimeModel} onChange={e => edit('realtimeModel', e.target.value)}>
        {REALTIME_MODELS.map(model => <option value={model} key={model}>{model}</option>)}
      </select></label>
      <details><summary>{t('rtSettingsAdvanced')}</summary><label>{t('rtSettingsCredentialRef')}<input disabled={disabled} required pattern="[A-Za-z_][A-Za-z0-9_]*" value={value.realtimeCredential}
        onChange={e => edit('realtimeCredential', e.target.value)} autoComplete="off"/></label></details>
      <div className="zj-actions"><Button type="submit" primary disabled={disabled}>{t(saving ? 'processing' : 'rtSettingsSave')}</Button>
        <Button disabled={saving || keySaving || !draft} onClick={() => { probeRef.current?.clear(); setDraft(null); setNotice(null); }}>{t('rtSettingsDiscard')}</Button></div>
      {!snapshot.writable && snapshot.status === 'ready' && <p role="status">{t('rtSettingsReadonly')}</p>}
      {notice && <p role="status" className="zj-status-line">{t(notice)}</p>}
    </form>
    <form className="zj-card zj-form" onSubmit={event => {
      event.preventDefault(); if (disabled || pendingRef || keySaving || !key.trim() || credential.status !== 'ready' || !credential.writable) return;
      void credentialGuard.current(async () => {
        probeRef.current?.clear();
        setKeySaving(true); const result = await storeCredential(savedRef, key);
        if (active.current) {
          setKeySaving(false); setKeyNotice(message('rtCredential', result));
          if (result === 'saved') { setKey(''); setCredential({ status: 'ready', configured: true, writable: true }); }
        }
      });
    }}>
      <h3>{t('rtCredentialTitle')}</h3><p className="zj-subtle">{t('rtCredentialNote')}</p>
      <p role="status">{t(credential.status === 'loading' ? 'loading' : credential.status !== 'ready' ? 'rtCredentialFailed'
        : credential.configured ? 'rtCredentialConfigured' : 'rtCredentialMissing')}</p>
      {pendingRef && <p role="status">{t('rtCredentialSaveSettingsFirst')}</p>}
      <label>{t('rtCredentialKey')}<input type="password" autoComplete="new-password" spellCheck={false} value={key}
        disabled={disabled || pendingRef || credential.status !== 'ready' || !credential.writable} onChange={e => { probeRef.current?.clear(); setKey(e.target.value); setKeyNotice(null); }}/></label>
      <div className="zj-actions"><Button type="submit" primary disabled={disabled || pendingRef || !key.trim() || credential.status !== 'ready' || !credential.writable}>{t(keySaving ? 'processing' : 'rtCredentialSave')}</Button>
        <Button disabled={saving || keySaving} onClick={() => { probeRef.current?.clear(); setRefresh(value => value + 1); }}>{t('refresh')}</Button></div>
      {credential.status === 'ready' && !credential.writable && <p role="status">{t('rtCredentialReadonly')}</p>}
      {keyNotice && <p role="status" className="zj-status-line">{t(keyNotice)}</p>}
      <p className="zj-subtle">{t('rtCredentialUntested')}</p>
      <p className="zj-subtle">{t('rtProbeNote')}</p>
      {unsaved && <p role="status">{t('rtProbeSaveFirst')}</p>}
      {!unsaved && !base.realtimeEnabled && <p role="status">{t('rtProbeEnableFirst')}</p>}
      <div className="zj-actions"><Button disabled={testDisabled} onClick={() => { if (!testDisabled) void probeRef.current?.start(); }}>{t(probe.status === 'running' ? 'rtProbeRunning' : 'rtProbeTest')}</Button>
        {probe.status === 'running' && <Button onClick={() => probeRef.current?.cancel()}>{t('rtProbeCancel')}</Button>}
        {probe.status === 'succeeded' && <>
          <Button disabled={probe.playing} onClick={() => { void probeRef.current?.play(); }}>{t('rtProbePlay')}</Button>
          <Button disabled={!probe.playing} onClick={() => probeRef.current?.stop()}>{t('rtProbeStop')}</Button>
          <Button onClick={() => probeRef.current?.clear()}>{t('rtProbeClear')}</Button>
        </>}
      </div>
      <div role="status" aria-live="polite">
        {probe.status === 'running' && <p>{t('rtProbeWaiting')}</p>}
        {probe.status === 'succeeded' && <><p>{t('rtProbeSuccess', probe.latencyMs)}</p><p className="zj-subtle">{t('rtProbeScope')}</p></>}
        {probe.message && <p>{t(probe.message)}</p>}
        {probe.playbackMessage && <p>{t(probe.playbackMessage)}</p>}
      </div>
    </form>
  </section>;
}
