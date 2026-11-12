import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeTransport } from '../client/voice/realtime-transport.js';
import { Config, realtimeCatalog, realtimeConfig } from '../src/voice/config.js';

test('official schema has credential reference only and catalog never reads secret values', async () => {
  const config = Config({ realtimeEnabled: true, realtimeWorkspace: 'workspace-fixture' });
  assert.equal(config.realtimeCredential.get(), 'ZHIJING_REALTIME_API_KEY');
  assert(!Object.keys(config).some(key => /secret|apikey|password/i.test(key)));
  assert.throws(() => Config({ realtimeCredential: 'not-a-ref' }));
  let described;
  const catalog = await realtimeCatalog({ get: () => ({ describe: async ref => { described = ref; return { configured: true, writable: true }; }, resolve: () => { throw new Error('Do not read secrets for catalog'); } }) }, config);
  assert.equal(described, 'ZHIJING_REALTIME_API_KEY'); assert.equal(catalog.configured, true);
  assert.equal(realtimeConfig(config).workspace, 'workspace-fixture');
  assert.throws(() => realtimeConfig({}), { code: 'not-configured' });
});

function streamResponse(chunks, cancelled = () => {}) {
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); }, cancel: cancelled }),
    { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
}
test('authenticated UTF8 stream handles arbitrary byte boundaries and async consumers in order', async () => {
  const bytes = new TextEncoder().encode('{"type":"call","epoch":1}\n{"type":"input-transcript","text":"你好"}\n');
  let request;
  const transport = createRealtimeTransport(async (url, options) => { request = { url, ...options }; return streamResponse([...bytes].map(byte => Uint8Array.of(byte))); });
  const events = [];
  await transport.open({ interviewId: 'fixture', ownerId: 'owner' }, { onEvent: async event => { await Promise.resolve(); events.push(event); } });
  assert.equal(request.credentials, 'same-origin'); assert.equal(request.method, 'POST');
  assert.equal(events[1].text, '你好'); assert.equal(events[0].epoch, 1);
});
test('transport rejects unauthenticated, truncated and oversized streams', async () => {
  const forbidden = createRealtimeTransport(async () => new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 403 }));
  await assert.rejects(forbidden.open({}), { code: 'UNAUTHORIZED' });
  const truncated = createRealtimeTransport(async () => streamResponse([new TextEncoder().encode('{"type":"call"}')]));
  await assert.rejects(truncated.open({}), { code: 'REALTIME_STREAM_TRUNCATED' });
  const oversized = createRealtimeTransport(async () => streamResponse([new TextEncoder().encode('a'.repeat(1024 * 1024 + 1))]));
  await assert.rejects(oversized.open({}), { code: 'REALTIME_EVENT_TOO_LARGE' });
});
