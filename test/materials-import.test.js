import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createMaterialImporter, MAX_UPLOAD_BYTES } from '../src/materials/index.js';
import { createHttpJobSource, resolvePublicJobUrl, normalizeJobUrl, isPublicJobAddress, extractPublicJob } from '../src/materials/runtime/index.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
async function setup(t) {
  const base = resolve('.runtime/zhijing/tests/plugin-materials'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'case-'));
  const materials = [];
  const career = { dispatch: async (action, data) => {
    if (action === 'state') return { materials };
    assert.equal(action, 'material.add');
    const version = { id: randomUUID(), text: data.text, hash: hash(data.text), source: data.source, confirmed: false };
    const material = { id: randomUUID(), title: data.title, kind: data.kind, latestVersionId: version.id, versions: [version] };
    materials.push(material); return material;
  } };
  const importer = createMaterialImporter({ directory, career });
  t.after(() => importer.close());
  return { importer, directory, materials };
}
const upload = (bytes, filename, mime, kind = 'resume') => ({ dataBase64: Buffer.from(bytes).toString('base64'), filename, mime, kind });

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [path, text] of entries) {
    const name = Buffer.from(path), body = Buffer.from(text), crc = crc32(body);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(body.length, 22); head.writeUInt16LE(name.length, 26);
    local.push(head, name, body);
    const item = Buffer.alloc(46); item.writeUInt32LE(0x02014b50); item.writeUInt16LE(20, 4); item.writeUInt16LE(20, 6); item.writeUInt32LE(crc, 16); item.writeUInt32LE(body.length, 20); item.writeUInt32LE(body.length, 24); item.writeUInt16LE(name.length, 28); item.writeUInt32LE(offset, 42);
    central.push(item, name); offset += head.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function docx() {
  return zip([['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>求职者测试简历：负责合成项目的接口测试和文档维护。</w:t></w:r></w:p></w:body></w:document>']]);
}
function pdf(text = 'Synthetic resume for parser verification. Developed a sample application and wrote reliable tests. No personal information is included.') {
  const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let output = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(output); output += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

test('TXT import retains original bytes/hash and immutable metadata and awaits user confirmation', async t => {
  const { importer, directory } = await setup(t);
  const bytes = Buffer.from('合成简历\r\n负责接口测试');
  const material = await importer.upload(upload(bytes, '../../resume.txt', 'text/plain'));
  assert.equal(material.title, 'resume.txt'); assert.equal(material.versions[0].confirmed, false);
  assert.equal(material.versions[0].text, '合成简历\n负责接口测试');
  const source = await importer.getSource({ versionId: material.latestVersionId });
  assert.equal(source.metadata.original.hash, hash(bytes)); assert.equal(source.source.requiresConfirmation, true);
  const original = await importer.getOriginal({ materialId: material.id }); assert.deepEqual(original.bytes, bytes);
  assert.deepEqual(await readFile(join(directory, 'files', source.source.originalFileId)), bytes);
  assert.ok((await readdir(join(directory, 'files'))).every(name => /^[a-f0-9-]{36}\.(txt|json)$/.test(name)));
});

test('real DOCX and PDF parsers return native text and source coordinates through the isolated process', async t => {
  const { importer } = await setup(t);
  const word = await importer.upload(upload(docx(), 'sample.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  assert.match(word.versions[0].text, /负责合成项目/);
  const wordSource = await importer.getSource({ materialId: word.id }); assert.equal(wordSource.metadata.document.blocks[0].kind, 'docx');
  const document = await importer.upload(upload(pdf(), 'sample.pdf', 'application/pdf'));
  assert.match(document.versions[0].text, /Synthetic resume/);
  const documentSource = await importer.getSource({ materialId: document.id });
  assert.equal(documentSource.metadata.document.blocks[0].kind, 'pdf'); assert.equal(documentSource.metadata.document.pageCount, 1);
});

test('text-poor PDF retains the original and requests screenshots without creating fake material', async t => {
  const { importer, directory, materials } = await setup(t);
  await assert.rejects(importer.upload(upload(pdf(''), 'scan.pdf', 'application/pdf')), error => {
    assert.equal(error.code, 'OCR_REQUIRED'); assert.match(error.original.fileId, /\.pdf$/); return true;
  });
  assert.equal(materials.length, 0); assert.ok((await readdir(join(directory, 'files'))).some(name => name.endsWith('.pdf')));
});

test('oversized, invalid UTF-8, MIME-spoofed and cancelled uploads never create a material', async t => {
  const { importer, materials } = await setup(t);
  await assert.rejects(importer.upload(upload(Buffer.alloc(MAX_UPLOAD_BYTES + 1), 'large.txt', 'text/plain')), { code: 'MATERIALS_TOO_LARGE' });
  await assert.rejects(importer.upload(upload(Buffer.from([0xff, 0xfe, 0xff]), 'bad.txt', 'text/plain')), { code: 'MATERIALS_UPLOAD_INVALID' });
  await assert.rejects(importer.upload(upload(pdf(), 'bad.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')), { code: 'MATERIALS_UPLOAD_INVALID' });
  await assert.rejects(importer.upload(upload('text', 'sample.txt', 'text/plain'), { signal: AbortSignal.abort() }), { code: 'MATERIALS_ACQUISITION_CANCELLED' });
  assert.equal(materials.length, 0);
});

test('source access requires an imported version, matching content hash and an unchanged regular original file', async t => {
  const { importer, directory, materials } = await setup(t);
  const material = await importer.upload(upload('Synthetic content', 'sample.txt', 'text/plain'));
  await assert.rejects(importer.getOriginal({ versionId: randomUUID() }), { code: 'MATERIALS_SOURCE_NOT_FOUND' });
  await writeFile(join(directory, 'files', material.versions[0].source.originalFileId), 'tampered');
  await assert.rejects(importer.getOriginal({ materialId: material.id }), { code: 'MATERIALS_SOURCE_NOT_FOUND' });
  materials[0].versions[0].source.metadataFileId = '../../private.json';
  await assert.rejects(importer.getSource({ materialId: material.id }), { code: 'MATERIALS_SOURCE_NOT_FOUND' });
});

test('URL validation denies private, mixed DNS, mapped IPv6 and nonpublic schemes before transport', async () => {
  for (const url of ['http://127.0.0.1', 'http://[::1]', 'file:///secret', 'https://name.local', 'https://user:key@example.com', 'http://2130706433']) assert.throws(() => normalizeJobUrl(url));
  for (const address of ['10.0.0.1', '169.254.169.254', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(isPublicJobAddress(address), false);
  await assert.rejects(resolvePublicJobUrl('https://example.com', { resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), /MATERIALS_URL_REJECTED/);
});

test('redirects are revalidated and admitted addresses are handed to pinned transport without another DNS lookup', async () => {
  let requests = 0, lookups = 0;
  const page = createHttpJobSource({ resolver: async hostname => { lookups++; return [{ address: hostname === 'example.com' ? '8.8.8.8' : '127.0.0.1', family: 4 }]; },
    transport: async ({ resolved }) => { requests++; assert.equal(resolved.selected.address, '8.8.8.8'); return { status: 302, headers: { location: 'https://other.example.com/private' }, body: new Uint8Array() }; } });
  await assert.rejects(page('https://example.com/job', new AbortController().signal), /MATERIALS_URL_REJECTED/);
  assert.equal(requests, 1); assert.equal(lookups, 2);
});

test('HTML extraction selects job content and refuses login or verification pages', () => {
  const text = extractPublicJob('<html><title>Test role</title><main><h1>Test Engineer</h1><p>Responsibilities: write repeatable tests, review defects, and maintain reliable documentation.</p></main></html>', 'https://example.com/job?token=private', 'https://example.com/job');
  assert.match(text.text, /Responsibilities/); assert.equal(text.source.sourceUrl, 'https://example.com/job');
  assert.throws(() => extractPublicJob('<html><title>Verify you are human</title><main>Responsibilities: fake content just to bypass extraction checks.</main></html>', 'https://example.com/job', 'https://example.com/job'), /MATERIALS_SITE_VERIFICATION/);
});
