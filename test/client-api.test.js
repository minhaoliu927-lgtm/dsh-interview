import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../client/api.js';

test('career actions use same-origin authenticated JSON and preserve cancellation',async()=>{
  const abort=new AbortController();
  const calls=[];
  const api=createApi(async(path,options)=>{calls.push({path,options});return new Response(JSON.stringify({ok:true,data:{id:'version'}}),{headers:{'content-type':'application/json'}});});
  assert.deepEqual(await api.request('material.confirm',{versionId:'version'},{signal:abort.signal}),{id:'version'});
  assert.equal(calls[0].path,'/zhijing/api');assert.equal(calls[0].options.credentials,'same-origin');
  assert.deepEqual(JSON.parse(calls[0].options.body),{action:'material.confirm',input:{versionId:'version'}});
  assert.equal(calls[0].options.signal,abort.signal);
});

test('business failures retain stable codes and never become data',async()=>{
  const api=createApi(async()=>new Response(JSON.stringify({ok:false,error:{code:'MATERIAL_NOT_CONFIRMED',message:'Review text first'}}),{status:409}));
  await assert.rejects(api.request('assessment.run',{}),error=>error.code==='MATERIAL_NOT_CONFIRMED'&&error.message==='Review text first');
  const invalid=createApi(async()=>new Response('<html>proxy error</html>',{status:502}));
  await assert.rejects(invalid.request('state'),error=>error.code==='INVALID_RESPONSE');
});

test('file upload preserves bytes and sends only selected material metadata',async()=>{
  let body;
  const api=createApi(async(_path,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({ok:true,data:{id:'material'}}));});
  const file={name:'简历.docx',type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',size:4,arrayBuffer:async()=>Uint8Array.from([0,255,128,1]).buffer};
  await api.upload(file,{title:'My resume',kind:'resume'});
  assert.equal(body.dataBase64,'AP+AAQ==');assert.equal(body.filename,'简历.docx');assert.equal(body.kind,'resume');
  await assert.rejects(api.upload({...file,size:26*1024*1024},{kind:'resume'}),error=>error.code==='FILE_TOO_LARGE');
});

test('document export returns actual response bytes rather than an invented path',async()=>{
  const api=createApi(async(path,options)=>{
    assert.equal(path,'/zhijing/export');assert.deepEqual(JSON.parse(options.body),{kind:'report',id:'report-id',format:'pdf'});
    return new Response('%PDF-1.7',{headers:{'content-type':'application/pdf'}});
  });
  const result=await api.exportDocument('report','report-id','pdf');
  assert.equal(await result.blob.text(),'%PDF-1.7');assert.match(result.filename,/\.pdf$/);
});

test('original downloads use only a version identity and the authenticated server filename',async()=>{
  const api=createApi(async(path,options)=>{
    assert.equal(path,'/zhijing/original');assert.equal(options.credentials,'same-origin');
    assert.deepEqual(JSON.parse(options.body),{versionId:'v1'});
    return new Response('original bytes',{headers:{'content-type':'text/plain','content-disposition':"attachment; filename*=UTF-8''%E7%AE%80%E5%8E%86.txt"}});
  });
  const result=await api.original('v1');assert.equal(result.filename,'简历.txt');assert.equal(await result.blob.text(),'original bytes');
});

test('request identities belong to action and upload envelopes, never business input', async () => {
  const sent = [], signal = new AbortController().signal;
  const api = createApi(async (path, options) => { sent.push({ path, ...options }); return new Response(JSON.stringify({ ok: true, data: {} })); });
  await api.request('assessment.run', { versionId: 'frozen-v1' }, { requestId: 'own-action-1', signal });
  assert.deepEqual(JSON.parse(sent[0].body), { action: 'assessment.run', input: { versionId: 'frozen-v1' }, requestId: 'own-action-1' });
  const file = { name: 'resume.txt', type: 'text/plain', size: 2, arrayBuffer: async () => new Uint8Array([65, 66]).buffer };
  await api.upload(file, { title: 'Resume', kind: 'resume', requestId: 'untrusted-metadata' }, { requestId: 'own-upload-2', signal });
  const upload = JSON.parse(sent[1].body); assert.equal(upload.requestId, 'own-upload-2'); assert.equal(upload.input, undefined);
  assert.equal(upload.dataBase64, 'QUI='); assert.equal(sent[1].signal, signal); assert.equal(sent[1].credentials, 'same-origin');
  for (const requestId of ['', '../foreign', 'x'.repeat(101)]) {
    assert.throws(() => api.request('assessment.run', {}, { requestId }), { code: 'INVALID_REQUEST_ID' });
  }
  assert.equal(sent.length, 2);
});

test('an upload cancelled during file reading never sends its late bytes to the Host', async () => {
  let resolveRead, fetched = 0;
  const controller = new AbortController();
  const file = { name: 'resume.txt', type: 'text/plain', size: 2, arrayBuffer: () => new Promise(resolve => { resolveRead = resolve; }) };
  const api = createApi(async () => { fetched++; return new Response('{}'); });
  const pending = api.upload(file, { kind: 'resume' }, { requestId: 'upload-own', signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' }); controller.abort(); resolveRead(new Uint8Array([65, 66]).buffer);
  await rejected; assert.equal(fetched, 0);
});

test('exports and original reads keep their independent transport scope', async () => {
  const sent = [];
  const api = createApi(async (_path, options) => { sent.push(JSON.parse(options.body)); return new Response('bytes'); });
  await api.exportDocument('report', 'report-1', 'pdf', { requestId: 'not-a-task' });
  await api.original('version-1', { requestId: 'not-a-task' });
  assert.deepEqual(sent, [{ kind: 'report', id: 'report-1', format: 'pdf' }, { versionId: 'version-1' }]);
});
