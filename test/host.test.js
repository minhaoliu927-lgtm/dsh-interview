import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHostServices, requestRejection, publicError, apply } from '../src/host.js';
import { registerCareerTools } from '../src/tools.js';
import { createModelGenerator } from '../src/model.js';

test('HTTP errors redact native paths and transport details', () => {
  for (const code of ['EACCES', 'ERR_SQLITE_ERROR', 'SQLITE_CANTOPEN', 'ECONNREFUSED']) {
    const value = publicError(Object.assign(new Error('private path or request'), { code }));
    assert.equal(value.code, 'OPERATION_FAILED'); assert(!value.message.includes('private'));
  }
  assert.equal(publicError(Object.assign(new Error('请先确认'), { code: 'MATERIAL_NOT_CONFIRMED' })).message, '请先确认');
  assert.equal(publicError(new Error('private'), true).code, 'CANCELLED');
});

test('connection authentication is required and cross-site writes are refused', () => {
  assert.equal(requestRejection({ get: () => undefined }, { headers: {} }), 403);
  const ctx = { get: () => ({ requestRejection: ({ headers }) => headers.authorization === 'test' ? undefined : 401 }) };
  assert.equal(requestRejection(ctx, { headers: {} }), 401);
  assert.equal(requestRejection(ctx, { headers: { authorization: 'test', 'sec-fetch-site': 'cross-site' } }), 403);
  assert.equal(requestRejection(ctx, { headers: { authorization: 'test', 'sec-fetch-site': 'same-origin' } }), undefined);
});

test('UI and tools use the same persisted service; tools cannot confirm or accept', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zhijing-host-'));
  const registered = new Map();
  const ctx = { get: () => undefined, on: () => () => {}, tools: { register(tool) { registered.set(tool.name, tool); } } };
  const services = createHostServices(ctx, directory);
  try {
    registerCareerTools(ctx, services.dispatch);
    const tool = registered.get('zhijing_materials');
    const value = await tool.execute({ action: 'material.add', input: { title: '简历', kind: 'resume', text: '测试工程师，负责自动化测试。' } }, {});
    const state = await services.dispatch('state');
    assert.equal(state.materials[0].id, value.id);
    await assert.rejects(tool.execute({ action: 'material.confirm', input: { versionId: value.latestVersionId } }, {}));
    assert(!registered.get('zhijing_rewrite').parameters.properties.action.enum.includes('rewrite.accept'));
    const summary = await registered.get('zhijing_state').execute({}, {});
    assert(!JSON.stringify(summary).includes('负责自动化测试'));
    await assert.rejects(tool.execute({ action: 'material.get', input: { versionId: value.latestVersionId } }, {}), { code: 'MATERIAL_NOT_CONFIRMED' });
    const preview = await services.dispatch('material.get', { versionId: value.latestVersionId });
    assert.equal(preview.text, '测试工程师，负责自动化测试。');
    await services.dispatch('material.confirm', { versionId: value.latestVersionId });
    const selected = await tool.execute({ action: 'material.get', input: { versionId: value.latestVersionId } }, {});
    assert.equal(selected.text, '测试工程师，负责自动化测试。');
  } finally { await services.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('voice cannot write credentials or accept plugin-specific service settings', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zhijing-credentials-'));
  const writes = [];
  const services = createHostServices({ get: name => name === 'credentials' ? { set: async (...args) => writes.push(args) } : undefined }, directory);
  try {
    for (const action of ['credential.save', 'voice.save', 'voice.settings', 'voice.synthesize']) {
      await assert.rejects(services.dispatch(action, { ref: 'ANY_REFERENCE', value: 'test-secret' }), { code: 'VOICE_MANAGED_BY_HOST' });
    }
    assert.deepEqual(writes, []);
    assert(!JSON.stringify(await services.dispatch('state')).includes('test-secret'));
    await services.close(); await assert.rejects(services.dispatch('state'), { code: 'PLUGIN_CLOSED' });
  } finally { await services.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('DSH generation records selected model and rejects unfinished or malformed results', async () => {
  let chunks = [{ type: 'text-delta', text: '{"answer":1}' }, { type: 'finish', reason: { kind: 'stop' } }];
  const requests = [];
  const ctx = { get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fixture', model: 'test-model' }) };
    if (name === 'llm') return { async prepareCall(config) { return { config, async *stream(input) { requests.push(input); yield* chunks; } }; } };
  } };
  const generate = createModelGenerator(ctx);
  const result = await generate({ task: 'test', system: 'test', input: { original: '简历' } });
  assert.deepEqual(result.model, { provider: 'fixture', model: 'test-model' }); assert.equal(result.result.answer, 1);
  assert(requests[0].messages[0].content[0].text.includes('简历'));
  chunks = [{ type: 'text-delta', text: '{}' }];
  await assert.rejects(generate({ task: 'test', system: '', input: {} }), { code: 'MODEL_INCOMPLETE' });
  chunks = [{ type: 'text-delta', text: 'not JSON' }, { type: 'finish', reason: { kind: 'stop' } }];
  await assert.rejects(generate({ task: 'test', system: '', input: {} }), { code: 'MODEL_INVALID_JSON' });
});

test('generation uses trusted session model selection and never a model field from material input', async () => {
  const calls = [];
  const generate = createModelGenerator({ get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) };
    if (name === 'llm') return { async prepareCall(config) { calls.push(config); return { config, async *stream() {
      yield { type: 'text-delta', text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } };
    } }; } };
  } });
  const args = { task: 'test', system: '', input: { modelSelection: { provider: 'untrusted', model: 'input' } } };
  const modelSelection = { provider: 'session-provider', model: 'session-model', reasoningEffort: 'high' };
  const result = await generate({ ...args, modelSelection });
  assert.equal(calls[0].provider, modelSelection.provider); assert.equal(calls[0].model, modelSelection.model); assert.equal(calls[0].reasoningEffort, 'high');
  assert.deepEqual(result.model, { provider: 'session-provider', model: 'session-model' });
  await generate(args); assert.equal(calls[1].provider, 'default-provider');
  for (const selection of [{ ...modelSelection, apiKey: 'must-not-forward' }, { provider: '', model: 'x' }, { provider: 'x', model: 'y', reasoningEffort: {} }]) {
    await assert.rejects(generate({ ...args, modelSelection: selection }), { code: 'MODEL_SELECTION_INVALID' });
  }
  assert.equal(calls.length, 2);
});

test('plugin lifecycle registers routes and a real bundled skill, then releases resources', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zhijing-plugin-'));
  const disposers = []; let route, provider; const tools = [];
  const ctx = { dshHomePath: () => directory, get: () => undefined, on: () => () => {},
    inject(_names, operation) { operation(ctx); },
    tools: { register: tool => tools.push(tool) }, skills: { registerProvider: factory => { provider = factory(); } },
    webServer: { register(value) { route = value; return () => { route = undefined; }; } },
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose); } };
  try {
    apply(ctx); assert.equal(route.path, '/zhijing'); assert.equal(tools.length, 8);
    const [candidate] = await provider.list(); const skill = await provider.get(candidate);
    assert(skill.content.includes('zhijing_interview'));
    for (const dispose of disposers.reverse()) await dispose();
    assert.equal(route, undefined);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
