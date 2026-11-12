import React from 'react';
import { Button } from '../components.jsx';
import { createRealtimeCall, realtimeUnavailable } from './realtime-call.js';

export function realtimeErrorKey(state) {
  if (state.capabilityMissing) return 'realtimeConfigure';
  if (/microphone|permission|device|worklet/i.test(state.errorCode || '')) return 'realtimeMicrophoneError';
  if (state.errorCode === 'transcription-failed') return 'realtimeTranscriptError';
  if (/audio|playback|backpressure/i.test(state.errorCode || '')) return 'realtimeAudioError';
  return 'realtimeConnectionError';
}

/** A single continuous call; review and durable evidence belong to the Host. */
export function RealtimeCall({ interview, api, t, onChanged, openSettings }) {
  const [state, setState] = React.useState({ phase: 'idle', muted: false, stopping: false, checking: false,
    inputTranscript: '', outputTranscript: '', errorCode: null, capabilityMissing: false, catalog: null });
  const controller = React.useRef(null), changed = React.useRef(onChanged);
  changed.current = onChanged;
  React.useEffect(() => {
    const owned = createRealtimeCall({ interviewId: interview.id, api, onChange: setState, onChanged: () => changed.current?.() });
    controller.current = owned;
    void owned.refreshCatalog();
    return () => { controller.current = null; void owned.dispose(); };
  }, [api, interview.id]);
  React.useEffect(() => { if (interview.status === 'completed') void controller.current?.end(); }, [interview.status]);
  const actions = Object.fromEntries(['start', 'setMuted', 'interrupt', 'pause', 'end', 'refreshCatalog'].map(name => [name, (...args) => controller.current?.[name](...args)]));
  return <RealtimeCallView interview={interview} state={state} t={t} actions={actions} openSettings={openSettings}/>;
}

export function RealtimeCallView({ interview, state, t, actions = {}, openSettings }) {
  const active = ['listening', 'speaking', 'thinking'].includes(state.phase);
  const connecting = ['requesting', 'connecting'].includes(state.phase);
  const phaseKeys = { idle: 'realtimeIdle', requesting: 'realtimeRequesting', connecting: 'realtimeConnecting',
    listening: 'realtimeListening', speaking: 'realtimeSpeaking', thinking: 'realtimeThinking', paused: 'realtimePaused', ended: 'realtimeEnded', error: 'realtimeEnded' };
  const question = interview.questions?.find(row => row.id === interview.currentQuestionId)?.text || '';
  const output = state.outputTranscript || question;
  const settings = () => { try { openSettings?.(); } catch { /* Existing status retains the retry path. */ } };

  return <section className="zj-card zj-realtime-call" aria-label={t('realtimeCall')} aria-busy={state.stopping || connecting}>
    <span className="zj-eyebrow">{t('realtimeCall')}</span>
    <h2 className="zj-question" role="status" aria-live="polite">{t(phaseKeys[state.phase] || 'realtimeIdle')}</h2>
    {!active && !connecting && <p className="zj-subtle">{t('realtimeAudioNotice')}</p>}
    <div className="zj-actions">
      {active ? <>
        <Button primary aria-pressed={state.muted} onClick={() => actions.setMuted?.(!state.muted)}>{t(state.muted ? 'realtimeUnmute' : 'realtimeMute')}</Button>
        <Button onClick={() => { void actions.interrupt?.(); }}>{t('realtimeInterrupt')}</Button>
        <Button onClick={() => { void actions.pause?.(); }}>{t('pause')}</Button>
        <Button quiet onClick={() => { void actions.end?.(); }}>{t('realtimeEnd')}</Button>
      </> : connecting ? <Button onClick={() => { void actions.end?.(); }}>{t('cancel')}</Button> :
        <Button primary disabled={state.stopping || state.checking || realtimeUnavailable(state.catalog) || interview.status === 'completed'} onClick={() => { void actions.start?.(); }}>{t(state.phase === 'idle' ? 'realtimeStart' : 'realtimeReconnect')}</Button>}
      {!active && !connecting && <>
        <Button quiet disabled={state.stopping || !openSettings} onClick={settings}>{t('realtimeSettings')}</Button>
        <Button quiet disabled={state.stopping || state.checking} onClick={() => { void actions.refreshCatalog?.(); }}>{t('refreshVoice')}</Button>
      </>}
    </div>
    {state.muted && <p className="zj-status-line">{t('realtimeMute')}</p>}
    {(state.errorCode || state.capabilityMissing) && <p className="zj-error" role="alert">{t(realtimeErrorKey(state))}</p>}
    {output && <div className="zj-voice"><span className="zj-eyebrow">{t('realtimeInterviewer')}</span><p className="zj-paper-content">{output}</p></div>}
    {state.inputTranscript && <div className="zj-voice"><span className="zj-eyebrow">{t('realtimeYou')}</span><p className="zj-paper-content">{state.inputTranscript}</p></div>}
    {(output || state.inputTranscript) && <p className="zj-subtle">{t('realtimeTranscriptNote')}</p>}
  </section>;
}
