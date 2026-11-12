import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = fileURLToPath(new URL('../', import.meta.url));
const buildResult = await build({ absWorkingDir: root, entryPoints: ['client/voice/realtime-call.jsx'], bundle: true,
  format: 'cjs', platform: 'browser', external: ['react'], write: false });
const module = { exports: {} };
vm.runInNewContext(buildResult.outputFiles[0].text, { module, exports: module.exports, require });
const { RealtimeCallView, realtimeErrorKey } = module.exports;
const interview = { id: 'i1', status: 'active', currentQuestionId: 'q1', questions: [{ id: 'q1', text: 'Tell me about your project.' }] };
const view = state => renderToStaticMarkup(React.createElement(RealtimeCallView, { interview, state, t: key => key, openSettings: () => {} }));

test('a continuous call exposes mute, interruption, pause and end without per-turn recording or answer submission', () => {
  const html = view({ phase: 'listening', muted: true, inputTranscript: 'My original words', outputTranscript: 'A follow-up question' });
  for (const key of ['realtimeUnmute', 'realtimeInterrupt', 'pause', 'realtimeEnd', 'My original words', 'A follow-up question']) assert.ok(html.includes(key), key);
  assert.match(html, /aria-pressed="true"/);
  assert.doesNotMatch(html, /<textarea|record|submitAnswer|useTranscript|realtimeReconnect/);
});

test('unavailable realtime service has a disabled start and reachable host settings and refresh actions', () => {
  const html = view({ phase: 'idle', capabilityMissing: true, catalog: { available: false } });
  assert.match(html, /disabled=""[^>]*>realtimeStart/);
  assert.match(html, /<button[^>]*>realtimeSettings<\/button>/);
  assert.match(html, /<button[^>]*>refreshVoice<\/button>/);
  assert.ok(html.includes('realtimeConfigure')); assert.ok(html.includes('realtimeAudioNotice'));
  const unconfigured = view({ phase: 'idle', capabilityMissing: true, catalog: { available: true, configured: false } });
  assert.match(unconfigured, /disabled=""[^>]*>realtimeStart/);
  assert.match(unconfigured, /<button[^>]*>realtimeSettings<\/button>/);
  assert.ok(unconfigured.includes('realtimeConfigure'));
});

test('connecting can be cancelled and error rendering never includes provider messages or stack details', () => {
  assert.ok(view({ phase: 'connecting' }).includes('>cancel</button>'));
  const html = view({ phase: 'error', errorCode: 'network', error: 'secret-server-detail' });
  assert.ok(html.includes('realtimeConnectionError')); assert.ok(html.includes('realtimeReconnect'));
  assert.ok(!html.includes('secret-server-detail'));
  assert.equal(realtimeErrorKey({ errorCode: 'microphone-unavailable' }), 'realtimeMicrophoneError');
  assert.equal(realtimeErrorKey({ errorCode: 'invalid-playback-audio' }), 'realtimeAudioError');
  assert.equal(realtimeErrorKey({ errorCode: 'transcription-failed' }), 'realtimeTranscriptError');
});

test('a newly created realtime interview renders before its first question or answer draft exists', async () => {
  const built = await build({ absWorkingDir: root, entryPoints: ['client/interview.jsx'], bundle: true,
    format: 'cjs', platform: 'browser', external: ['react'], write: false });
  const compiled = { exports: {} };
  vm.runInNewContext(built.outputFiles[0].text, { module: compiled, exports: compiled.exports, require });
  const html = renderToStaticMarkup(React.createElement(compiled.exports.Interview, {
    state: { reports: [] }, interview: { id: 'empty-realtime', mode: 'realtime', status: 'paused', questions: [], currentQuestionId: null },
    t: key => key, realtimeApi: {},
  }));
  assert.match(html, /realtimeStart/); assert.match(html, /realtimeAudioNotice/);
  assert.doesNotMatch(html, /submitAnswer|<textarea/);
});
