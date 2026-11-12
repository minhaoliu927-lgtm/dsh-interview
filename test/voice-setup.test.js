import test from 'node:test';
import assert from 'node:assert/strict';
import { DSH_VOICE_BUNDLE, enableDshVoice, voiceSetupMessage } from '../client/voice/setup.js';
import { zh, en } from '../locale/dictionaries.js';

const shipped = { name: DSH_VOICE_BUNDLE, availability: 'installation', installed: false, enabled: false };
const change = application => ({ ok: true, value: { application, target: DSH_VOICE_BUNDLE, enabled: true } });
function fixture({ rows = [shipped], result = change('applied'), open = true } = {}) {
  const calls = [];
  return { calls, options: { getManager: () => ({
    async listBundles() { calls.push(['list']); return { ok: true, value: rows }; },
    async setBundleEnabled(...args) { calls.push(['enable', ...args]); return result; },
  }), openSettings() { calls.push(['settings']); return open; } } };
}

test('explicit setup enables a shipped optional bundle even when installed is false, then opens official setup', async () => {
  const value = fixture();
  assert.deepEqual(await enableDshVoice(value.options), { status: 'applied' });
  assert.deepEqual(value.calls, [['list'], ['enable', DSH_VOICE_BUNDLE, true], ['settings']]);
});

test('profile availability is usable and no navigation does not misreport successful enablement as failure', async () => {
  const value = fixture({ rows: [{ ...shipped, availability: 'profile', installed: true }], open: false });
  assert.deepEqual(await enableDshVoice(value.options), { status: 'applied-no-navigation' });
});

test('missing or inaccessible bundles cannot cause installation, enablement, or a model download', async () => {
  for (const rows of [[], [{ ...shipped, availability: 'missing', installed: true }]]) {
    const value = fixture({ rows });
    assert.deepEqual(await enableDshVoice(value.options), { status: 'missing' });
    assert.deepEqual(value.calls, [['list']]);
  }
  assert.deepEqual(await enableDshVoice({ getManager: () => undefined }), { status: 'unavailable' });
});

test('restart and override results remain distinct and never open the preparation page as if activation succeeded', async () => {
  for (const application of ['restart-required', 'overridden']) {
    const value = fixture({ result: change(application) });
    assert.deepEqual(await enableDshVoice(value.options), { status: application });
    assert.deepEqual(value.calls, [['list'], ['enable', DSH_VOICE_BUNDLE, true]]);
    for (const dictionary of [zh, en]) assert.ok(dictionary[voiceSetupMessage(application)]);
  }
});

test('remote and management failures are not rendered as success or raw diagnostics', async () => {
  for (const result of [{ ok: false, error: { message: 'private-path-or-token' } }, change('failed'), change('cancelled'),
    { ...change('applied'), value: { ...change('applied').value, error: { diagnostic: 'private-path-or-token' } } },
    { ok: true, value: { application: 'applied', target: 'another-package', enabled: true } }]) {
    const value = fixture({ result });
    assert.deepEqual(await enableDshVoice(value.options), { status: 'failed' });
    assert.equal(value.calls.some(row => row[0] === 'settings'), false);
  }
  const blocked = fixture({ rows: [{ ...shipped, readOnlyReason: 'management-required' }] });
  assert.deepEqual(await enableDshVoice(blocked.options), { status: 'failed' });
  assert.deepEqual(blocked.calls, [['list']]);
});

test('a closed workbench cannot enable after a delayed read or navigate after a delayed host mutation', async () => {
  for (const stage of ['list', 'enable']) {
    const abort = new AbortController(), pending = Promise.withResolvers();
    let mutations = 0, navigations = 0;
    const operation = enableDshVoice({ signal: abort.signal, getManager: () => ({
      listBundles: async () => stage === 'list' ? pending.promise : { ok: true, value: [shipped] },
      async setBundleEnabled() { mutations++; return pending.promise; },
    }), openSettings: () => { navigations++; return true; } });
    await Promise.resolve(); await Promise.resolve();
    abort.abort(); pending.resolve(stage === 'list' ? { ok: true, value: [shipped] } : change('applied'));
    await assert.rejects(operation, { name: 'AbortError' });
    assert.equal(navigations, 0); assert.equal(mutations, stage === 'list' ? 0 : 1);
    // Persisted user intent belongs to DSH; disposal never sends a disable call.
  }
});
