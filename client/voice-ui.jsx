import React from 'react';
import { createVoiceController } from './voice/controller.js';
import { voiceSetupMessage } from './voice/setup.js';
import { Button } from './components.jsx';

export function VoiceSetup({ t, enableVoiceInput, openVoiceSettings }) {
  const [status, setStatus] = React.useState('idle');
  const lifetime = React.useRef(null), pending = React.useRef(false);
  React.useEffect(() => {
    const current = new AbortController(); lifetime.current = current;
    return () => { current.abort(); };
  }, []);
  const enable = async () => {
    const current = lifetime.current;
    if (!current || current.signal.aborted || pending.current) return;
    pending.current = true; setStatus('enabling');
    try {
      const result = await enableVoiceInput?.({ signal: current.signal });
      if (!current.signal.aborted) setStatus(result?.status ?? 'unavailable');
    } catch { if (!current.signal.aborted) setStatus('failed'); }
    finally { pending.current = false; }
  };
  const openSettings = () => {
    try { if (!openVoiceSettings?.()) setStatus('unavailable'); } catch { setStatus('unavailable'); }
  };
  return <div className="zj-rail-footer"><p className="zj-subtle">{t('voiceManagedByHost')}</p>
    <Button quiet small disabled={status === 'enabling'} onClick={() => { void enable(); }}>{t(status === 'enabling' ? 'voiceEnabling' : 'enableHostVoice')}</Button>
    <Button quiet small disabled={status === 'enabling'} onClick={openSettings}>{t('hostVoiceSettings')}</Button>
    <p className="zj-subtle" role="status" aria-live="polite">{t(voiceSetupMessage(status))}</p>
  </div>;
}

export function VoiceAnswer({ api, t, question, interviewId, questionId, language, onDraft, disabled }) {
  const [state, setState] = React.useState({ phase: 'idle', transcript: '', error: null, catalog: null, elapsedSeconds: 0 });
  const controller = React.useRef(null);
  React.useEffect(() => {
    const owned = createVoiceController({ api, onChange: setState, language, transcriptionContext: { interviewId, questionId },
      translateError: ({ code }) => t(code === 'device-speech-busy' ? 'systemSpeechBusy' : code.startsWith('device-') ? 'systemSpeechUnavailable' : code.startsWith('host-') ? 'hostAsrUnavailable' : 'voiceUnavailable') });
    controller.current = owned;
    return () => { controller.current = null; void owned.dispose(); };
  }, [api, interviewId, questionId, language]);
  React.useEffect(() => { void controller.current?.refreshCatalog(); }, [api, interviewId, questionId, language]);
  React.useEffect(() => { if (disabled) controller.current?.cancel(); }, [disabled]);
  const phaseKeys = { idle: 'voiceIdle', requesting: 'voiceRequesting', recording: 'voiceRecording', transcribing: 'voiceTranscribing', playing: 'voicePlaying', synthesizing: 'processing' };
  const recording = state.phase === 'recording';
  const working = ['requesting','transcribing'].includes(state.phase);
  return <div className="zj-voice"><div className="zj-actions">
    {recording ? <Button small onClick={() => controller.current?.stopRecording()}>{t('stopRecord')}</Button> : <Button small disabled={disabled || working || !state.catalog?.asr.available} onClick={() => controller.current?.startRecording()}>{t('record')}</Button>}
    {(recording || working) && <Button small quiet onClick={() => controller.current?.cancel()}>{t('discardRecord')}</Button>}
    {['playing','synthesizing'].includes(state.phase) ? <Button small onClick={() => controller.current?.stopPlayback()}>{t('stopListen')}</Button> : <Button small disabled={!question || recording || !state.catalog?.tts.available} onClick={() => controller.current?.speak(question)}>{t('listen')}</Button>}
    <Button small quiet disabled={recording || working} onClick={() => controller.current?.refreshCatalog()}>{t('refreshVoice')}</Button>
  </div><p className="zj-voice-state" role="status">{state.phase !== 'idle' ? `${t(phaseKeys[state.phase])}${recording ? ` · ${state.elapsedSeconds}s` : ''}` : !state.catalog?.asr.available ? t('hostAsrUnavailable') : t('voiceHint')}</p>
    {!state.catalog?.tts.available && <p className="zj-subtle">{t('systemSpeechUnavailable')}</p>}
    {state.error && <p className="zj-error" role="alert">{state.error}</p>}
    {state.rawTranscript && state.rawTranscript !== state.transcript && <details><summary>{t('voiceOriginalTranscript')}</summary><p>{state.rawTranscript}</p></details>}
    {state.transcript && <div className="zj-form"><label>{t('voiceDraft')}<textarea value={state.transcript} onChange={e => controller.current?.setTranscript(e.target.value)}/></label><div><Button small disabled={disabled} onClick={() => { const draft = controller.current?.takeTranscriptDraft(); if (draft) onDraft(draft.text, draft); }}>{t('useTranscript')}</Button></div></div>}
  </div>;
}
