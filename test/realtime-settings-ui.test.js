import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { en, zh } from '../locale/dictionaries.js';

const require = createRequire(import.meta.url), React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const built = await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['client/realtime-settings.jsx'],
  bundle: true, format: 'cjs', platform: 'browser', external: ['react'], loader: { '.css': 'text' }, write: false });
function load(react = React) {
  const module = { exports: {} };
  vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : require(name), console,
    URL, Blob, AbortController, atob, crypto: globalThis.crypto, setTimeout, clearTimeout });
  return module.exports;
}
const ui = load(), plain = value => JSON.parse(JSON.stringify(value));
const translate = dictionary => (key, params = {}) => String(dictionary[key] || key).replace(/\{([^}]+)\}/g, (_match, name) => params[name] ?? name);
const t = translate(en);
function fixture() {
  const calls = [], snapshot = { status: 'ready', writable: true, revision: 4, value: {
    realtimeEnabled: false, realtimeRegion: 'beijing', realtimeWorkspace: 'synthetic-workspace',
    realtimeModel: 'qwen3.5-omni-plus-realtime', realtimeCredential: 'ZHIJING_REALTIME_API_KEY' } };
  const form = { getSnapshot: () => snapshot, subscribe: () => () => {}, async mutate(ops, revision) { calls.push(['mutate', ops, revision]); return true; } };
  const credentials = { async describe(refs) { calls.push(['describe', refs]); return { ok: true, value: { [refs[0]]: { configured: false, writable: true } } }; },
    async set(ref, value) { calls.push(['set', ref, value]); return { ok: true }; }, resolve() { assert.fail('Browser must never resolve credentials'); } };
  return { calls, snapshot, form, credentials };
}

test('settings contributes the official bundle slot with a stable ConfigForms/credential face and disposes it', () => {
  const f = fixture(); let registration, component, removed = false;
  const ctx = { get(name) { return name === 'configForms' ? { get(ns) { assert.equal(ns, 'dsh-interview'); return f.form; } }
    : name === 'remote.credentials' ? f.credentials : undefined; },
    slots: { inject(name, callback) { assert.equal(name, 'plugins.bundle.config'); return callback(); }, register(options, view) {
      registration = options; component = view; return () => { removed = true; };
    } } };
  const dispose = ui.registerRealtimeSettings(ctx, 'zhijing');
  assert.equal(registration.key, 'dsh-interview'); assert.equal(registration.locale, 'zhijing'); assert.equal(component, ui.RealtimeSettings);
  const face = registration.inject(); assert.equal(face, registration.inject()); assert.equal(face.describeCredential, registration.inject().describeCredential);
  assert.equal(face.hooks.realtimeSettings, f.form); assert.equal(f.calls.length, 0);
  dispose(); assert.equal(removed, true);
});

test('voice configuration writes only its five public fields atomically with the observed revision', async () => {
  const f = fixture(), actions = ui.createRealtimeSettingsActions(f.form, f.credentials);
  assert.equal(await actions.saveSettings({ ...f.snapshot.value, realtimeEnabled: true, apiKey: 'must-not-save-to-config' }, 4), 'saved');
  assert.equal(f.calls.length, 1); const [, ops, revision] = f.calls[0]; assert.equal(revision, 4);
  assert.equal(ops.length, 5); assert(ops.every(row => row.op === 'set' && row.path.length === 1));
  assert.equal(JSON.stringify(ops).includes('must-not-save-to-config'), false);
  assert.deepEqual(plain(ops.map(row => row.path[0])).sort(), Object.keys(f.snapshot.value).sort());
  assert.equal(await actions.saveSettings({ ...f.snapshot.value, realtimeEnabled: true, realtimeWorkspace: '' }, 4), 'invalid');
  assert.equal(await actions.saveSettings({ ...f.snapshot.value, realtimeModel: 'arbitrary-model' }, 4), 'invalid');
  assert.equal(await actions.saveSettings({ ...f.snapshot.value, realtimeCredential: 'not valid' }, 4), 'invalid');
  assert.equal(f.calls.length, 1);
  f.form.mutate = async () => false; assert.equal(await actions.saveSettings(f.snapshot.value, 4), 'conflict');
  f.form.mutate = async () => { throw new Error('untrusted service error'); }; assert.equal(await actions.saveSettings(f.snapshot.value, 4), 'failed');
  f.snapshot.writable = false; assert.equal(await actions.saveSettings(f.snapshot.value, 4), 'readonly');
});

test('credential controls describe only their saved reference, project safe metadata, and write only through official credentials Remote', async () => {
  const f = fixture(), ref = f.snapshot.value.realtimeCredential;
  f.credentials.describe = async refs => { f.calls.push(['describe', refs]); return { ok: true, value: { [ref]: {
    configured: true, writable: true, value: 'must-not-read', extra: 'must-not-render' } } }; };
  const actions = ui.createRealtimeSettingsActions(f.form, f.credentials);
  assert.deepEqual(plain(await actions.describeCredential(ref)), { status: 'ready', configured: true, writable: true });
  assert.equal(await actions.storeCredential(ref, 'synthetic-credential-only'), 'saved');
  assert.deepEqual(f.calls.at(-1), ['set', ref, 'synthetic-credential-only']);
  assert.equal(f.calls.some(row => row[0] === 'mutate'), false);
  const count = f.calls.length;
  assert.equal((await actions.describeCredential('UNRELATED_REFERENCE')).status, 'unavailable');
  assert.equal(await actions.storeCredential('UNRELATED_REFERENCE', 'synthetic'), 'invalid'); assert.equal(f.calls.length, count);
  f.credentials.describe = async () => ({ ok: false, error: { message: 'must-not-render secret' } });
  assert.deepEqual(plain(await actions.describeCredential(ref)), { status: 'failed' });
  assert.equal(await actions.storeCredential(ref, 'synthetic'), 'failed');
  f.credentials.describe = async () => ({ ok: true, value: { [ref]: { configured: true, writable: false } } });
  assert.equal(await actions.storeCredential(ref, 'synthetic'), 'readonly');
  assert.equal(f.calls.length, count);
});

test('missing namespace or Host services remain unavailable and never probe unrelated credentials', async () => {
  const f = fixture(), actions = ui.createRealtimeSettingsActions(undefined, f.credentials);
  assert.equal(actions.hooks.realtimeSettings.getSnapshot().status, 'unavailable');
  assert.equal(await actions.saveSettings(f.snapshot.value, 4), 'readonly');
  assert.equal((await actions.describeCredential(f.snapshot.value.realtimeCredential)).status, 'unavailable');
  assert.equal(f.calls.length, 0);
});

test('the official settings panel renders all options in both languages, with an empty password and no endpoint input', () => {
  const f = fixture(), actions = ui.createRealtimeSettingsActions(f.form, f.credentials);
  for (const dictionary of [en, zh]) {
    const html = renderToStaticMarkup(React.createElement(ui.RealtimeSettings, { ...actions, useRealtimeSettings: select => select(f.snapshot), t: translate(dictionary) }));
    for (const key of ['rtSettingsEnabled', 'rtSettingsRegion', 'rtSettingsWorkspace', 'rtSettingsModel', 'rtCredentialKey', 'rtSettingsSave', 'rtCredentialSave', 'rtCredentialUntested', 'rtProbeTest', 'rtProbeNote']) assert(html.includes(dictionary[key]), key);
    assert.match(html, /type="password"[^>]*autoComplete="new-password"[^>]*value=""/i);
    assert.equal(/type="url"|api\.openai|api\.deepseek|https:\/\//.test(html), false);
    assert(html.includes('data-zhijing-realtime-settings=""')); assert.equal(html.includes('rtSettingsNote'), false);
  }
});

function harness(initialProps) {
  let cursor = 0, props = initialProps; const slots = [], effects = [];
  const hooks = { ...React,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useEffect(callback, deps) { const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(previous.deps[i], value))) effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; }); },
  };
  const { RealtimeSettings } = load(hooks);
  return { render(next = {}) { props = { ...props, ...next }; cursor = 0; return RealtimeSettings(props); },
    effects() { while (effects.length) effects.shift()(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}
function nodes(value) { return Array.isArray(value) ? value.flatMap(nodes) : React.isValidElement(value) ? [value, ...nodes(value.props.children)] : []; }
const settle = () => new Promise(resolve => setImmediate(resolve));

test('explicit credential save is deduplicated, clears the typed secret, and does not make a settings write', async () => {
  const f = fixture(); let finish, saves = 0;
  f.credentials.set = async () => { saves++; return new Promise(resolve => { finish = resolve; }); };
  const actions = ui.createRealtimeSettingsActions(f.form, f.credentials), h = harness({ ...actions, t, useRealtimeSettings: select => select(f.snapshot) });
  h.render(); h.effects(); await settle();
  let tree = h.render(), password = nodes(tree).find(row => row.props.type === 'password'); assert.equal(password.props.disabled, false);
  password.props.onChange({ target: { value: 'synthetic-secret' } }); tree = h.render();
  const form = nodes(tree).filter(row => row.type === 'form')[1]; form.props.onSubmit({ preventDefault() {} }); form.props.onSubmit({ preventDefault() {} });
  await settle(); assert.equal(saves, 1); finish({ ok: true }); await settle();
  tree = h.render(); password = nodes(tree).find(row => row.props.type === 'password'); assert.equal(password.props.value, '');
  assert(nodes(tree).some(row => row.props.children === en.rtCredentialSaved)); assert.equal(f.calls.some(row => row[0] === 'mutate'), false);
});

test('changing the reference blocks credential writes until configuration is saved and errors never echo secret text', async () => {
  const f = fixture(); f.credentials.set = async () => { throw new Error('synthetic-secret must not appear'); };
  const actions = ui.createRealtimeSettingsActions(f.form, f.credentials), h = harness({ ...actions, t, useRealtimeSettings: select => select(f.snapshot) });
  h.render(); h.effects(); await settle(); let tree = h.render();
  nodes(tree).find(row => row.props.type === 'password').props.onChange({ target: { value: 'synthetic-secret' } }); tree = h.render();
  nodes(tree).filter(row => row.type === 'form')[1].props.onSubmit({ preventDefault() {} }); await settle(); tree = h.render();
  assert(nodes(tree).some(row => row.props.children === en.rtCredentialFailed));
  assert.equal(nodes(tree).some(row => typeof row.props.children === 'string' && row.props.children.includes('synthetic-secret')), false);
  const ref = nodes(tree).find(row => row.type === 'input' && row.props.pattern); ref.props.onChange({ target: { value: 'ZHIJING_OTHER_AUDIO_KEY' } }); tree = h.render();
  assert.equal(nodes(tree).find(row => row.props.type === 'password').props.disabled, true);
  assert(nodes(tree).some(row => row.props.children === en.rtCredentialSaveSettingsFirst));
});

function probeResult() {
  const bytes = Buffer.alloc(48); bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4, 40);
  return { ok: true, provider: 'aliyun', model: 'qwen3.5-omni-plus-realtime', latencyMs: { ready: 50, firstAudio: 100, total: 150 },
    checks: { handshake: true, audio: true, transcript: true }, audio: { mimeType: 'audio/wav', base64: bytes.toString('base64') } };
}
function probeFixture(overrides = {}) {
  const states = [], requests = [], cancels = [], created = [], revoked = [], timers = new Map();
  let nextId = 0, plays = 0, pauses = 0, loads = 0;
  const player = { play: async () => { plays++; }, pause: () => { pauses++; }, currentTime: 0,
    removeAttribute(name) { assert.equal(name, 'src'); }, load: () => { loads++; } };
  const controller = ui.createRealtimeProbe({
    testAudio: options => { requests.push(options); return overrides.testAudio?.(options) ?? Promise.resolve(probeResult()); },
    cancelAudio: options => { cancels.push(options); return Promise.resolve({ cancelled: true }); },
  }, { onChange: state => states.push(state), makeRequestId: () => `probe_${++nextId}`,
    urlApi: { createObjectURL(blob) { created.push(blob); return `blob:test-${created.length}`; }, revokeObjectURL(url) { revoked.push(url); } },
    makeAudio: () => player, setTimer: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; }, clearTimer: id => timers.delete(id) });
  return { controller, states, requests, cancels, created, revoked, timers, player,
    get plays() { return plays; }, get pauses() { return pauses; }, get loads() { return loads; } };
}
const button = (tree, label) => nodes(tree).find(row => typeof row.type === 'function' && row.props.children === label);

test('audio testing sends only an empty input with its own identity and never resolves a credential', async () => {
  const f = fixture(); f.snapshot.value.realtimeEnabled = true;
  f.credentials.describe = async ([ref]) => ({ ok: true, value: { [ref]: { configured: true, writable: false } } });
  const requests = [], api = { async request(...args) { requests.push(args); return probeResult(); } };
  const actions = ui.createRealtimeSettingsActions(f.form, f.credentials, api), controller = new AbortController();
  const options = { signal: controller.signal, requestId: 'audio_test_1' };
  assert.equal((await actions.testAudio(options)).ok, true);
  assert.equal(requests[0][0], 'realtime.test'); assert.deepEqual(plain(requests[0][1]), {}); assert.equal(requests[0][2], options);
  await actions.cancelAudio(options);
  assert.equal(requests[1][0], 'task.cancel'); assert.deepEqual(plain(requests[1][1]), { requestId: 'audio_test_1' });
  assert.equal(requests[1][2].signal, controller.signal); assert.equal(f.calls.length, 0);
  f.credentials.describe = async () => ({ ok: false });
  await assert.rejects(actions.testAudio(options), error => error.code === 'credential-unavailable');
  f.snapshot.value.realtimeEnabled = false;
  await assert.rejects(actions.testAudio(options), error => error.code === 'not-configured'); assert.equal(requests.length, 2);
});

test('a successful test is single flight, stores only temporary audio, and waits for explicit playback', async () => {
  let finish; const f = probeFixture({ testAudio: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.controller.start(); await f.controller.start(); assert.equal(f.requests.length, 1);
  assert.equal(f.states.at(-1).status, 'running'); assert.equal(f.plays, 0);
  finish(probeResult()); await pending;
  assert.deepEqual(plain(f.states.at(-1)), { status: 'succeeded', playing: false, latencyMs: { ready: 50, firstAudio: 100, total: 150 } });
  assert.equal(f.created[0].type, 'audio/wav'); assert.equal(f.plays, 0); assert.equal(f.timers.size, 0);
  await f.controller.play(); assert.equal(f.plays, 1); assert.equal(f.states.at(-1).playing, true);
  f.controller.stop(); assert.equal(f.states.at(-1).playing, false); assert.equal(f.player.currentTime, 0);
  await f.controller.play(); assert.equal(f.plays, 2);
  f.controller.clear(); assert.deepEqual(f.revoked, ['blob:test-1']); assert.equal(f.loads, 1); assert.equal(f.states.at(-1).status, 'idle');
  assert.equal(f.player.onended, null); assert.equal(f.player.onerror, null); assert.equal(f.cancels.length, 0);
});

test('cancel and the 30-second deadline abort only their own task and suppress ignored-abort late results', async () => {
  for (const mode of ['cancel', 'timeout']) {
    let finish; const f = probeFixture({ testAudio: () => new Promise(resolve => { finish = resolve; }) });
    const pending = f.controller.start();
    if (mode === 'cancel') f.controller.cancel();
    else { const timer = [...f.timers.values()].find(item => item.delay === 30000); assert(timer); timer.callback(); }
    assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.cancels.length, 1);
    assert.equal(f.cancels[0].requestId, f.requests[0].requestId); assert.notEqual(f.cancels[0].signal, f.requests[0].signal);
    assert.equal(f.states.at(-1).message, mode === 'cancel' ? 'rtProbeCancelled' : 'rtProbeTimeout');
    const count = f.states.length; finish(probeResult()); await pending; await settle();
    assert.equal(f.states.length, count); assert.equal(f.created.length, 0); assert.equal(f.timers.size, 0);
  }
});

test('disposal aborts a pending test, sends task cancellation, and never publishes after unmount', async () => {
  let finish; const f = probeFixture({ testAudio: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.controller.start(), count = f.states.length; f.controller.dispose();
  assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.cancels.length, 1);
  finish(probeResult()); await pending; await f.controller.start(); await settle();
  assert.equal(f.requests.length, 1); assert.equal(f.states.length, count); assert.equal(f.created.length, 0); assert.equal(f.timers.size, 0);
});

test('clearing a completed test revokes its audio on disposal and stale playback failures cannot restore it', async () => {
  const f = probeFixture(); await f.controller.start(); let rejectPlay;
  f.player.play = () => new Promise((_resolve, reject) => { rejectPlay = reject; });
  const playback = f.controller.play(); f.controller.clear(); const count = f.states.length;
  rejectPlay(new Error('device error with untrusted text')); await playback;
  assert.equal(f.states.length, count); assert.equal(f.states.at(-1).status, 'idle'); assert.equal(f.revoked.length, 1);
  await f.controller.start(); const completedCount = f.states.length; f.controller.dispose();
  assert.equal(f.revoked.length, 2); assert.equal(f.states.length, completedCount);
});

test('provider failures map to safe local strings and malformed success responses do not create playable audio', async () => {
  const cases = { 'authentication-failed': 'rtProbeAuthentication', 'access-denied': 'rtProbeAccess', 'endpoint-unavailable': 'rtProbeEndpoint',
    'rate-limited': 'rtProbeRateLimit', 'provider-unavailable': 'rtProbeProvider', 'dns-failed': 'rtProbeNetwork', 'tls-failed': 'rtProbeTls',
    'probe-timeout': 'rtProbeTimeout', BUSY: 'rtProbeBusy', 'credential-unavailable': 'rtProbeCredential',
    unknown: 'rtProbeFailed', constructor: 'rtProbeFailed' };
  for (const [code, expected] of Object.entries(cases)) {
    const f = probeFixture({ testAudio: async () => { throw Object.assign(new Error('secret or provider response must never appear'), { code }); } });
    await f.controller.start(); assert.equal(f.states.at(-1).message, expected); assert.equal(f.created.length, 0);
    assert.equal(JSON.stringify(f.states).includes('secret'), false); assert(en[expected]); assert(zh[expected]);
  }
  for (const change of [result => { result.audio.base64 = 'not-valid'; }, result => { result.checks.audio = false; },
    result => { result.latencyMs.total = NaN; }, result => { result.audio.mimeType = 'text/html'; }]) {
    const result = probeResult(); change(result); const f = probeFixture({ testAudio: async () => result });
    await f.controller.start(); assert.equal(f.states.at(-1).message, 'rtProbeFailed'); assert.equal(f.created.length, 0);
  }
});

async function readyProbePanel(overrides = {}) {
  const f = fixture(); f.snapshot.value.realtimeEnabled = true;
  f.credentials.describe = async ([ref]) => ({ ok: true, value: { [ref]: { configured: true, writable: true } } });
  const actions = ui.createRealtimeSettingsActions(f.form, f.credentials), h = harness({ ...actions, ...overrides, t, useRealtimeSettings: select => select(f.snapshot) });
  h.render(); h.effects(); await settle(); return { ...f, h };
}

test('settings test gates on saved fields and keys; edits cancel immediately and late success stays hidden', async () => {
  let finish, request, calls = 0; const cancels = [];
  const f = await readyProbePanel({ testAudio: options => { calls++; request = options; return new Promise(resolve => { finish = resolve; }); },
    cancelAudio: options => { cancels.push(options); return Promise.resolve(); } });
  let tree = f.h.render(); assert.equal(button(tree, en.rtProbeTest).props.disabled, false);
  button(tree, en.rtProbeTest).props.onClick(); button(tree, en.rtProbeTest).props.onClick(); assert.equal(calls, 1);
  tree = f.h.render(); assert(button(tree, en.rtProbeCancel));
  nodes(tree).find(row => row.props.type === 'password').props.onChange({ target: { value: 'unsaved-key' } });
  tree = f.h.render(); assert.equal(request.signal.aborted, true); assert.equal(cancels.length, 1);
  assert.equal(button(tree, en.rtProbeTest).props.disabled, true); assert(nodes(tree).some(row => row.props.children === en.rtProbeSaveFirst));
  finish(probeResult()); await settle(); tree = f.h.render(); assert.equal(button(tree, en.rtProbePlay), undefined);
  nodes(tree).find(row => row.props.type === 'password').props.onChange({ target: { value: '' } });
  tree = f.h.render(); assert.equal(button(tree, en.rtProbeTest).props.disabled, false);
  nodes(tree).find(row => row.type === 'select' && row.props.value === 'beijing').props.onChange({ target: { value: 'singapore' } });
  tree = f.h.render(); assert.equal(button(tree, en.rtProbeTest).props.disabled, true);
  button(tree, en.rtProbeTest).props.onClick(); assert.equal(calls, 1);
  button(tree, en.rtSettingsDiscard).props.onClick(); tree = f.h.render(); assert.equal(button(tree, en.rtProbeTest).props.disabled, false); f.h.unmount();
});

test('a test success shows elapsed time and limited scope; saved configuration changes clear stale success', async () => {
  const f = await readyProbePanel({ testAudio: async () => probeResult(), cancelAudio: async () => {} });
  button(f.h.render(), en.rtProbeTest).props.onClick(); await settle(); let tree = f.h.render();
  assert(button(tree, en.rtProbePlay)); assert.equal(button(tree, en.rtProbeStop).props.disabled, true);
  assert(nodes(tree).some(row => row.props.children === t('rtProbeSuccess', { ready: 50, firstAudio: 100, total: 150 })));
  assert(nodes(tree).some(row => row.props.children === en.rtProbeScope));
  f.snapshot.value.realtimeModel = 'qwen3.5-omni-flash-realtime'; f.snapshot.revision++;
  f.h.render(); f.h.effects(); tree = f.h.render(); assert.equal(button(tree, en.rtProbePlay), undefined); f.h.unmount();
});

test('the settings panel unmount aborts a pending audio test and cancels the Host task', async () => {
  let finish, request; const cancels = [];
  const f = await readyProbePanel({ testAudio: options => { request = options; return new Promise(resolve => { finish = resolve; }); },
    cancelAudio: options => { cancels.push(options); return Promise.resolve(); } });
  button(f.h.render(), en.rtProbeTest).props.onClick(); f.h.unmount();
  assert.equal(request.signal.aborted, true); assert.equal(cancels[0].requestId, request.requestId);
  finish(probeResult()); await settle();
});
