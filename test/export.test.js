import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import yauzl from 'yauzl';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { exportCareerDocument } from '../src/export.js';

const original = '林同学\n求职方向：软件测试工程师\n负责接口测试，整理测试用例。\n曾使用 Python 编写自动化脚本。\n<脚本内容只作为正文，不运行>\n';
const version = { id: 'v1', confirmed: true, text: original.repeat(12) };
const career = { async dispatch(action) {
  assert.equal(action, 'state'); return { materials: [{ id: 'm1', title: '测试简历', kind: 'resume', versions: [version] }] };
} };
async function zipEntry(bytes, filename) {
  return new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    zip.on('error', reject); zip.on('end', () => reject(new Error('Entry absent')));
    zip.on('entry', entry => {
      if (entry.fileName !== filename) return zip.readEntry();
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks = []; stream.on('data', chunk => chunks.push(chunk)); stream.on('error', reject);
        stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks).toString('utf8')); });
      });
    }); zip.readEntry();
  }));
}

test('DOCX contains the selected Chinese version as actual Word paragraphs', async () => {
  const result = await exportCareerDocument(career, { kind: 'resume', id: 'v1', format: 'docx' });
  assert.equal(result.bytes.subarray(0, 2).toString(), 'PK');
  const xml = await zipEntry(result.bytes, 'word/document.xml');
  assert(xml.includes('软件测试工程师')); assert(xml.includes('&lt;脚本内容只作为正文，不运行&gt;'));
  assert.equal((xml.match(/负责接口测试/g) ?? []).length, 12);
});

test('PDF embeds Chinese glyphs, paginates long resumes, and can be independently read and rendered', async () => {
  const result = await exportCareerDocument(career, { kind: 'resume', id: 'v1', format: 'pdf' });
  assert.equal(result.bytes.subarray(0, 4).toString(), '%PDF');
  const loading = getDocument({ data: new Uint8Array(result.bytes), useSystemFonts: false, isEvalSupported: false, verbosity: 0 });
  const document = await loading.promise;
  try {
    assert(document.numPages >= 2);
    let content = '';
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index); content += (await page.getTextContent()).items.map(item => item.str ?? '').join('');
    }
    assert.equal((content.match(/负责接口测试/g) ?? []).length, 12);
    assert(content.includes('软件测试工程师'));
    const page = await document.getPage(1), viewport = page.getViewport({ scale: 1.3 });
    const { canvas, context } = document.canvasFactory.create(viewport.width, viewport.height);
    await page.render({ canvasContext: context, viewport }).promise;
    await fs.writeFile(path.join(os.tmpdir(), 'zhijing-export-verified.png'), canvas.toBuffer('image/png'));
    await fs.writeFile(path.join(os.tmpdir(), 'zhijing-export-verified.pdf'), result.bytes);
  } finally { await loading.destroy(); }
});

test('PDF keeps searchable Unicode digits in Latin and Chinese resume and report text', async () => {
  const lines = ['合成候选人', '使用 Python 整理1200条记录。', 'Synthetic candidate',
    'Prepared 1200 records using Python.', 'Digits 0123456789; GPA 3.75; growth 25%; 2024-06.',
    '中文编号 0123456789，成绩 87.5，日期 2026-11-06。', 'Office efficiency and affiliation.'];
  const report = { id: 'report-1200', versionId: 'version-2026', rubricVersion: 'rubric-1',
    summary: lines.join('\n'), total: 87.5, criteria: [], createdAt: '2026-11-06T12:34:56.000Z' };
  const fixture = { async dispatch(action) {
    if (action === 'report.get') return report;
    assert.equal(action, 'state');
    return { materials: [{ title: 'Synthetic export', kind: 'resume', versions: [{ id: 'digits', confirmed: true, text: lines.join('\n') }] }] };
  } };
  for (const kind of ['resume', 'report']) {
    const result = await exportCareerDocument(fixture, { kind, id: kind === 'resume' ? 'digits' : report.id, format: 'pdf' });
    const loading = getDocument({ data: new Uint8Array(result.bytes), useSystemFonts: false, isEvalSupported: false, verbosity: 0 });
    const document = await loading.promise;
    try {
      let extracted = '';
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        const page = await document.getPage(pageNumber);
        extracted += (await page.getTextContent()).items.map(item => item.str ?? '').join('');
      }
      for (const line of lines) assert.ok(extracted.includes(line), `${kind} lost searchable text: ${line}`);
      assert.doesNotMatch(extracted, /[\uE000-\uF8FF]/u, 'Ordinary digits must not become private-use glyph codes');
      assert.ok(extracted.includes(`1 / ${document.numPages}`), 'Page numbers must remain searchable');
      if (kind === 'report') for (const value of ['总分 87.5 / 100', report.id, report.versionId, report.rubricVersion, report.createdAt]) {
        assert.ok(extracted.includes(value), `Report lost ${value}`);
      }
    } finally { await loading.destroy(); }
  }
});

test('English interview exports use the saved report language for headings and evidence labels', async () => {
  const report = { id: 'report-en', versionId: 'version-en', language: 'en', summary: 'A course project answer.', total: null,
    criteria: [{ id: 'evidence', name: '回答中的事实依据', reason: 'Concrete details.', evidence: [{ quote: 'I cleaned 1200 records.' }] }],
    rubricVersion: 'rubric-1', createdAt: '2026-11-07', strengths: ['Clear scope.'], improvements: ['Explain checks.'], nextSteps: ['Give one example.'] };
  const service = { dispatch: async () => report };
  const result = await exportCareerDocument(service, { kind: 'report', id: report.id, format: 'docx' });
  const xml = await zipEntry(result.bytes, 'word/document.xml');
  assert(xml.includes('Interview report')); assert(xml.includes('Answer evidence: I cleaned 1200 records.'));
  assert(xml.includes('There is not enough evidence')); assert(!xml.includes('回答中的事实依据'));
  assert.equal(result.filename, 'Zhijing interview report.docx');
});

test('PDF wraps English paragraphs at word boundaries and bounds oversized identifiers', async () => {
  const paragraph = 'The response is clear and includes some concrete project facts, but it largely restates actions instead of explaining methods. It leaves the interviewer unable to see how duplicates were identified, how missing values were handled, or what makes the documentation reproducible.';
  const identifier = 'a'.repeat(220);
  const fixture = { dispatch: async () => ({ materials: [{ title: 'Word wrapping', kind: 'resume',
    versions: [{ id: 'wrapped', confirmed: true, text: `${paragraph}\n${identifier}` }] }] }) };
  const result = await exportCareerDocument(fixture, { kind: 'resume', id: 'wrapped', format: 'pdf' });
  const loading = getDocument({ data: new Uint8Array(result.bytes), useSystemFonts: false, isEvalSupported: false, verbosity: 0 });
  const document = await loading.promise;
  try {
    const page = await document.getPage(1);
    const items = (await page.getTextContent()).items.filter(item => item.str?.trim() && item.str !== '1 / 1');
    const body = items.filter(item => !/^a+$/u.test(item.str));
    assert(body.length > 1, 'Fixture must wrap onto several lines');
    assert.equal(body.map(item => item.str.trim()).join(' '), paragraph, 'No inserted word break or lost boundary space');
    assert.equal(items.filter(item => /^a+$/u.test(item.str)).map(item => item.str).join(''), identifier);
    for (const item of items) assert(item.width <= 595.28 - 96 + 0.1, 'Text must fit between the page margins');
  } finally { await loading.destroy(); }
});

test('export refuses unknown versions, unconfirmed drafts and arbitrary formats', async () => {
  await assert.rejects(exportCareerDocument(career, { kind: 'resume', id: 'missing', format: 'docx' }), { code: 'VERSION_NOT_FOUND' });
  await assert.rejects(exportCareerDocument(career, { kind: 'resume', id: 'v1', format: 'html' }), { code: 'INVALID_EXPORT' });
  const pending = { dispatch: async () => ({ materials: [{ kind: 'resume', title: 'draft', versions: [{ ...version, confirmed: false }] }] }) };
  await assert.rejects(exportCareerDocument(pending, { kind: 'resume', id: 'v1', format: 'pdf' }), { code: 'MATERIAL_NOT_CONFIRMED' });
});
