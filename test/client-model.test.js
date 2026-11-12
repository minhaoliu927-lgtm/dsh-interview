import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCareerClient, goalHasJob, latestAssessment, resumeOptions, versionEntry, citationSource, quoteSegments } from '../client/model.js';
import { createApi } from '../client/api.js';
import { createHostServices, publicError } from '../src/host.js';
import { careerSessionProvider, parseSessionAddress, sessionAddress } from '../client/session.js';
import { en, zh } from '../locale/dictionaries.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const fixture = () => ({
  materials: [
    { id:'resume', kind:'resume', title:'Resume', latestVersionId:'r2', versions:[{id:'r2', revision:2, confirmed:false},{id:'r1',revision:1,confirmed:true}] },
    { id:'job', kind:'job', versions:[{id:'j1', confirmed:true}] },
  ],
  assessments:[{id:'new', kind:'resume', versionId:'r1', total:70},{id:'old',kind:'resume',versionId:'r1',total:60}],
});

test('analysis uses a confirmed immutable version and preserves previous results', () => {
  const state = fixture();
  assert.deepEqual(resumeOptions(state).map(row => row.version.id), ['r1']);
  assert.equal(versionEntry(state,'r1').material.id,'resume');
  assert.equal(latestAssessment(state,'r2'),null);
  assert.equal(latestAssessment(state,'r1').id,'new');
  assert.equal(goalHasJob(state,{materialLinks:[{versionId:'j1'}]}),true);
  assert.equal(goalHasJob(state,{description:'a job title',materialLinks:[]}),false);
});

test('a stale state read cannot overwrite a completed mutation', async () => {
  const first = deferred();
  const writes = deferred();
  const data = fixture();
  let reads = 0;
  const client = createCareerClient({request(action) {
    if(action === 'state') return ++reads === 1 ? first.promise : Promise.resolve(data);
    return writes.promise;
  }}, {schedule:() => 1,unschedule:() => {}});
  const observed=[];
  const unsubscribe=client.source.subscribe(() => observed.push(client.source.getSnapshot()));
  const mutation=client.action('material.confirm',{versionId:'r1'});
  writes.resolve({id:'r1'});
  first.resolve({materials:[]});
  await mutation;
  assert.equal(client.source.getSnapshot().data,data);
  assert.equal(client.source.getSnapshot().pending,0);
  assert.equal(observed.some(row=>row.ready && row.data.materials.length===0),false);
  unsubscribe();client.dispose();
});

test('failed mutation remains visible without fabricating a completed result',async()=>{
  const error=Object.assign(new Error('Model unavailable'),{code:'MODEL_UNAVAILABLE'});
  const client=createCareerClient({request:async action=>{if(action==='state')return fixture();throw error;}},{schedule:()=>1,unschedule:()=>{}});
  await assert.rejects(client.action('assessment.run',{}),error);
  assert.equal(client.source.getSnapshot().error,error);
  assert.equal(client.source.getSnapshot().ready,false);
  assert.equal(client.source.getSnapshot().pending,0);
  client.dispose();
});

test('subscriber and plugin disposal stop polling and abort in-flight reads',async()=>{
  let cancelled=0, stopped=0, captured;
  const client=createCareerClient({request:(_action,_input,{signal})=>{captured=signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{cancelled++;reject(Object.assign(new Error('aborted'),{name:'AbortError'}));}));}},{schedule:()=>7,unschedule:id=>{assert.equal(id,7);stopped++;}});
  const unsubscribe=client.source.subscribe(()=>{});
  assert.equal(captured.aborted,false);
  unsubscribe();client.dispose();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stopped,1);assert.equal(cancelled,1);assert.equal(captured.aborted,true);
});

test('native conversation resources retain one host session and release on abort',async()=>{
  const controller=new AbortController();
  const events=[];
  const reference={release(){events.push('release');}};
  const provider=careerSessionProvider({async refresh(){events.push('refresh');},retain(id,options){assert.equal(id,'session-id');assert.equal(options.source,'zhijingChat');events.push('retain');return reference;}});
  const iterator=provider.open(sessionAddress('session-id'),{signal:controller.signal});
  const first=await iterator.next();
  assert.equal(first.value.value.reference,reference);
  const closing=iterator.next();controller.abort();await closing;
  assert.deepEqual(events,['refresh','retain','release']);
});

test('unknown session becomes a visible resource failure rather than an uncaught stream error',async()=>{
  const provider=careerSessionProvider({async refresh(){},retain(){throw new Error('Unknown session');}});
  const iterator=provider.open(sessionAddress('missing'),{signal:new AbortController().signal});
  const result=await iterator.next();assert.equal(result.value.ok,false);assert.match(result.value.error.message,/Unknown/);
  await iterator.return();
  assert.throws(()=>parseSessionAddress('https://example.com/session/a'));
  assert.throws(()=>parseSessionAddress('dsh-resource://zhijingchat/session/a%2Fb'));
});

test('Chinese and English dictionaries cover the same product text and placeholders',()=>{
  assert.deepEqual(Object.keys(en).sort(),Object.keys(zh).sort());
  for(const key of Object.keys(en)) {
    assert.equal(typeof en[key],'string');
    assert.deepEqual([...en[key].matchAll(/\{([^}]+)\}/g)].map(row=>row[1]).sort(),[...zh[key].matchAll(/\{([^}]+)\}/g)].map(row=>row[1]).sort(),key);
  }
});

test('citations resolve their exact saved source and highlight UTF-16 ranges without guessing duplicate quotes',()=>{
  const state={...fixture(),interviews:[{questions:[{text:'Question',answer:{id:'a1',text:'Original answer'}}]}]};
  state.materials[0].versions[0].text='New version';
  state.materials[0].versions[1].text='旧版😀原始经历。';
  assert.equal(citationSource(state,'r1').text,'旧版😀原始经历。');
  assert.equal(citationSource(state,'a1').text,'Original answer');
  assert.deepEqual(quoteSegments('旧版😀原始经历。',{quote:'原始经历',start:4,end:8}),{before:'旧版😀',quote:'原始经历',after:'。'});
  assert.deepEqual(quoteSegments('重复，重复',{quote:'重复'}),{before:'重复，重复',quote:'',after:''});
});

test('direct tasks expose real running/refreshing/succeeded facts and retain prior analysis during the operation', async t => {
  const write = deferred(), refresh = deferred(), old = { ...fixture(), rewrites: [{ id: 'previous-rewrite' }] };
  let reads = 0, options;
  const client = createCareerClient({ request(action, _input, config) {
    if (action === 'state') return ++reads === 1 ? Promise.resolve(old) : refresh.promise;
    options = config; return write.promise;
  } }, { requestIdFactory: () => 'my-task', now: () => 123 }); t.after(() => client.dispose());
  await client.refresh(); const pending = client.action('rewrite.run', { versionId: 'r1' });
  let state = client.source.getSnapshot();
  assert.equal(state.data, old); assert.deepEqual(state.data.rewrites, [{ id: 'previous-rewrite' }]);
  assert.equal(state.operation.action, 'rewrite.run'); assert.equal(state.operation.requestId, options.requestId);
  assert.equal(state.operation.startedAt, 123); assert.equal(state.operation.status, 'running'); assert.equal(state.operation.canCancel, true);
  write.resolve({ id: 'new-rewrite' }); await tick(); state = client.source.getSnapshot();
  assert.equal(state.operation.status, 'refreshing'); assert.equal(state.operation.canCancel, false); assert.equal(state.operation.saveAcknowledged, true);
  assert.deepEqual(await client.cancelCurrent(), { cancelled: false });
  refresh.resolve({ ...old, rewrites: [{ id: 'new-rewrite' }, ...old.rewrites] }); await pending;
  assert.equal(client.source.getSnapshot().operation.status, 'succeeded');
  assert.equal(client.source.getSnapshot().lastOperation.requestId, 'my-task'); assert.equal(client.source.getSnapshot().operations.length, 0);
});

test('cancelCurrent aborts immediately and targets only its own Host ID; late success cannot become completed', async t => {
  const write = deferred(), hostCancel = deferred(), calls = [], old = fixture(); let captured;
  const client = createCareerClient({ request(action, input, options) {
    calls.push({ action, input, options });
    if (action === 'state') return Promise.resolve(old);
    if (action === 'task.cancel') return hostCancel.promise;
    captured = options.signal; return write.promise;
  } }, { requestIdFactory: () => 'own-task' }); t.after(() => client.dispose());
  await client.refresh(); const pending = client.action('assessment.run', { versionId: 'r1' }); const rejected = assert.rejects(pending, { name: 'AbortError' });
  const cancelling = client.cancelCurrent(); assert.equal(captured.aborted, true); await rejected;
  assert.equal(client.source.getSnapshot().operation.status, 'cancelled');
  const cancel = calls.find(call => call.action === 'task.cancel');
  assert.deepEqual(cancel.input, { requestId: 'own-task' }); assert.equal(cancel.options.signal.aborted, false);
  assert.equal(client.source.getSnapshot().data, old); assert.equal(client.source.getSnapshot().pending, 0);
  hostCancel.resolve({ cancelled: true }); await cancelling;
  write.resolve({ id: 'late-success' }); await tick();
  assert.equal(client.source.getSnapshot().operation.status, 'cancelled'); assert.equal(client.source.getSnapshot().operation.saveAcknowledged, false);
  assert.equal(client.source.getSnapshot().operation.cancelState, 'acknowledged');
  assert.equal(calls.filter(call => call.action === 'task.cancel').length, 1);
  assert.deepEqual(await client.cancelCurrent(), { cancelled: false });
});

test('concurrent tasks have independent cancellation and older results cannot replace newer receipt or facts', async t => {
  const first = deferred(), second = deferred(), third = deferred(), cancel = []; let id = 0;
  const client = createCareerClient({ request(action, input) {
    if (action === 'state') return Promise.resolve(fixture());
    if (action === 'task.cancel') { cancel.push(input.requestId); return Promise.resolve({ cancelled: true }); }
    return [first, second, third][input.order - 1].promise;
  } }, { requestIdFactory: () => `own-${++id}` }); t.after(() => client.dispose());
  const a = client.action('assessment.run', { order: 1 });
  const b = client.action('rewrite.run', { order: 2 }); const rejected = assert.rejects(b, { name: 'AbortError' });
  assert.equal(client.source.getSnapshot().operation.requestId, 'own-2'); assert.equal(client.source.getSnapshot().operations.length, 2);
  await client.cancelCurrent(); await rejected;
  assert.deepEqual(cancel, ['own-2']); assert.equal(client.source.getSnapshot().operation.requestId, 'own-1');
  assert.deepEqual(await client.cancelCurrent('own-2'), { cancelled: false }, 'a stale card click must not cancel the newly selected older task');
  const c = client.action('material.confirm', { order: 3 }); third.resolve({ id: 'saved' }); await c;
  assert.equal(client.source.getSnapshot().operation.requestId, 'own-1'); assert.equal(client.source.getSnapshot().lastOperation.requestId, 'own-3');
  first.resolve({ id: 'older-result' }); await a; second.resolve({ id: 'late-cancelled-result' }); await tick();
  assert.equal(client.source.getSnapshot().operation.requestId, 'own-3'); assert.equal(client.source.getSnapshot().operation.status, 'succeeded');
  assert.equal(client.source.getSnapshot().pending, 0);
});

test('failed tasks can be retried with fresh identities while earlier reports and rewrites stay visible', async t => {
  let calls = 0, ids = 0; const previous = { ...fixture(), reports: [{ id: 'old-report' }], rewrites: [{ id: 'old-rewrite' }] };
  const client = createCareerClient({ request: async action => {
    if (action === 'state') return previous;
    if (++calls === 1) throw Object.assign(new Error('Temporary model failure'), { code: 'MODEL_UNAVAILABLE' });
    return { id: 'retry-result' };
  } }, { requestIdFactory: () => `retry-${++ids}` }); t.after(() => client.dispose());
  await client.refresh(); await assert.rejects(client.action('rewrite.run', {}), { code: 'MODEL_UNAVAILABLE' });
  assert.equal(client.source.getSnapshot().operation.status, 'failed'); assert.equal(client.source.getSnapshot().data, previous);
  await client.action('rewrite.run', {}); assert.equal(client.source.getSnapshot().operation.requestId, 'retry-2');
  assert.equal(client.source.getSnapshot().operation.status, 'succeeded'); assert.equal(client.source.getSnapshot().error, null);
});

test('native perform, source reads and polling neither create cancellable direct tasks nor invoke Host cancellation', async t => {
  const native = deferred(), calls = []; let poll;
  const client = createCareerClient({ request: async action => { calls.push(action); return action === 'state' ? fixture() : { source: true }; } },
    { schedule: callback => { poll = callback; return 1; }, unschedule() {} }); t.after(() => client.dispose());
  const unsubscribe = client.source.subscribe(() => {}); await tick();
  const pending = client.perform(() => native.promise); assert.equal(client.source.getSnapshot().operation, null);
  assert.deepEqual(await client.cancelCurrent(), { cancelled: false });
  await client.action('material.source', { versionId: 'r1' }); assert.equal(client.source.getSnapshot().operation, null);
  poll(); native.resolve('native-result'); await pending; poll(); await tick(); poll(); await tick();
  assert.equal(calls.includes('task.cancel'), false); assert.equal(client.source.getSnapshot().operation, null);
  unsubscribe();
});

test('upload gets its own task ID and cancellation timeout never restores a cancelled task', async t => {
  const upload = deferred(); let options;
  const client = createCareerClient({ request: action => action === 'state' ? Promise.resolve(fixture()) : new Promise(() => {}),
    upload: (_file, _metadata, value) => { options = value; return upload.promise; } }, { requestIdFactory: () => 'upload-1', cancelTimeoutMs: 10 });
  t.after(() => client.dispose());
  const pending = client.upload({ name: 'resume.docx' }, { kind: 'resume' }), rejected = assert.rejects(pending, { name: 'AbortError' });
  assert.equal(client.source.getSnapshot().operation.action, 'material.upload'); assert.equal(options.requestId, 'upload-1');
  const result = await client.cancelCurrent(); await rejected;
  assert.equal(result.hostCancelled, null); assert.equal(client.source.getSnapshot().operation.cancelState, 'failed');
  upload.resolve({ id: 'late' }); await tick(); assert.equal(client.source.getSnapshot().operation.status, 'cancelled');
});

test('request IDs cannot be reused or overridden to cancel another caller', async t => {
  const client = createCareerClient({ request: async action => action === 'state' ? fixture() : { id: 'saved' } }, { requestIdFactory: () => 'same-id' });
  t.after(() => client.dispose()); await client.action('goal.create', {});
  await assert.rejects(client.action('goal.create', {}), { code: 'INVALID_REQUEST_ID' });
  await assert.rejects(client.action('task.cancel', { requestId: 'foreign-agent' }), { code: 'CLIENT_TASK_INTERNAL' });
});

async function realHost(t, generate) {
  const base = path.resolve(process.env.ZHIJING_TEST_ROOT ?? fileURLToPath(new URL('../.runtime/tests/client-model/', import.meta.url)));
  fs.mkdirSync(base, { recursive: true }); const directory = fs.mkdtempSync(path.join(base, 'client-task-'));
  const services = createHostServices({ get: () => undefined }, directory, { generate });
  t.after(async () => { await services.close(); assert.equal(path.dirname(directory), base); fs.rmSync(directory, { recursive: true, force: true }); });
  return services;
}
function hostFetch(services, requests, hold) {
  return async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, body });
    try {
      // Intentionally do not forward the browser abort: this proves task.cancel
      // reaches the Host even when a transport cannot cancel an existing write.
      const result = await services.dispatch(body.action, body.input, { requestId: body.requestId });
      if (hold) await hold(body, result);
      return new Response(JSON.stringify({ ok: true, data: result }));
    } catch (cause) { const failure = publicError(cause); return new Response(JSON.stringify({ ok: false, error: failure }), { status: failure.status }); }
  };
}
const assessmentResult = input => ({ result: { criteria: input.rubric.map(row => ({ id: row.id, rating: 3, reason: '合成验证引用原文',
  evidence: [{ sourceId: input.snapshots[0].id, quote: input.snapshots[0].text }] })), suggestions: [], missing: [] }, model: { provider: 'fixture', model: 'bounded-local' } });

test('real Host slow generation cancels only this client request and preserves an independent Agent task and prior analysis', async t => {
  let slow = false; const started = new Map();
  const services = await realHost(t, async ({ input, signal }) => {
    if (!slow) return assessmentResult(input);
    const response = deferred(); started.set(input.snapshots[0].id, { signal, response, input }); return response.promise;
  });
  const versions = [];
  for (const text of ['负责测试设计与数据核对。', '维护项目文档和检查清单。']) {
    const material = await services.dispatch('material.add', { title: '合成简历', kind: 'resume', text });
    await services.dispatch('material.confirm', { versionId: material.latestVersionId }); versions.push(material.latestVersionId);
  }
  const original = await services.dispatch('assessment.run', { versionId: versions[0] }); slow = true;
  const requests = [], client = createCareerClient(createApi(hostFetch(services, requests)), { requestIdFactory: () => 'this-page-only' });
  t.after(() => client.dispose()); await client.refresh();
  const native = services.dispatch('assessment.run', { versionId: versions[1] }, { requestId: 'independent-native-agent' });
  const own = client.action('assessment.run', { versionId: versions[0] }); const rejected = assert.rejects(own, { name: 'AbortError' });
  for (let i = 0; i < 20 && started.size !== 2; i++) await tick(); assert.equal(started.size, 2);
  await client.cancelCurrent(); await rejected; await tick();
  assert.equal(started.get(versions[0]).signal.aborted, true); assert.equal(started.get(versions[1]).signal.aborted, false);
  const cancel = requests.find(row => row.body.action === 'task.cancel'); assert.deepEqual(cancel.body.input, { requestId: 'this-page-only' });
  assert.equal(requests.find(row => row.body.action === 'assessment.run').body.input.requestId, undefined);
  assert.equal(client.source.getSnapshot().data.assessments.some(row => row.id === original.id), true);
  const other = started.get(versions[1]); other.response.resolve(assessmentResult(other.input)); await native;
  const late = started.get(versions[0]); late.response.resolve(assessmentResult(late.input)); await tick(); await client.refresh();
  const state = await services.dispatch('state');
  assert.equal(state.assessments.filter(row => row.versionId === versions[0]).length, 1);
  assert.equal(state.assessments.filter(row => row.versionId === versions[1]).length, 1);
  assert.equal(state.runs.some(row => row.status === 'cancelled'), true); assert.equal(client.source.getSnapshot().operation.status, 'cancelled');
});

test('a real write committed before its response is cancelled stays saved after state reconciliation', async t => {
  const services = await realHost(t), committed = deferred(), releaseResponse = deferred(), requests = [];
  const client = createCareerClient(createApi(hostFetch(services, requests, async (body, result) => {
    if (body.action === 'material.add') { committed.resolve(result); await releaseResponse.promise; }
  })), { requestIdFactory: () => 'committed-response-lost' }); t.after(() => client.dispose());
  const pending = client.action('material.add', { title: '真实已提交的合成资料', kind: 'resume', text: '这是可保留的合成测试正文。' });
  const rejected = assert.rejects(pending, { name: 'AbortError' }); const saved = await committed.promise;
  const cancelled = await client.cancelCurrent(); await rejected; await tick();
  assert.equal(cancelled.hostCancelled, false); assert.equal(client.source.getSnapshot().operation.cancelState, 'not-active');
  await client.refresh(); assert.equal(client.source.getSnapshot().data.materials.some(row => row.id === saved.id), true);
  releaseResponse.resolve(); await tick();
  assert.equal(client.source.getSnapshot().operation.status, 'cancelled'); assert.equal(client.source.getSnapshot().operation.saveAcknowledged, false);
  assert.equal((await services.dispatch('state')).materials.some(row => row.id === saved.id), true, 'cancellation must never pretend to roll back a completed write');
});
