import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createMaterialImporter } from '../src/materials/index.js';

test('Windows OCR extracts a newly drawn synthetic image and preserves original bytes and word boxes', { skip: process.platform !== 'win32' }, async t => {
  const command = String.raw`Add-Type -AssemblyName System.Drawing
$bitmap = [Drawing.Bitmap]::new(1000,250)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$font = [Drawing.Font]::new('Arial',40)
$memory = [IO.MemoryStream]::new()
try {
  $graphics.Clear([Drawing.Color]::White)
  $graphics.DrawString('Software Engineer',[Drawing.Font]$font,[Drawing.Brushes]::Black,30,35)
  $graphics.DrawString('Build reliable tests',[Drawing.Font]$font,[Drawing.Brushes]::Black,30,120)
  $bitmap.Save($memory,[Drawing.Imaging.ImageFormat]::Png)
  [Console]::Write([Convert]::ToBase64String($memory.ToArray()))
} finally { $memory.Dispose(); $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }`;
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  const bytes = Buffer.from(stdout.trim(), 'base64');
  const base = resolve('.runtime/zhijing/tests/plugin-materials'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'ocr-'));
  const materials = [];
  const career = { dispatch: async (action, data) => {
    if (action === 'state') return { materials };
    assert.equal(action, 'material.add');
    const version = { id: randomUUID(), text: data.text, source: data.source, hash: createHash('sha256').update(data.text).digest('hex'), confirmed: false };
    const material = { id: randomUUID(), title: data.title, latestVersionId: version.id, versions: [version] }; materials.push(material); return material;
  } };
  const importer = createMaterialImporter({ directory, career }); t.after(() => importer.close());
  let material;
  try { material = await importer.upload({ filename: 'synthetic-job.png', mime: 'image/png', dataBase64: bytes.toString('base64'), title: 'Synthetic role', kind: 'job' }); }
  catch (error) { if (error.code === 'MATERIALS_OCR_UNAVAILABLE') { t.skip('Windows OCR language component is unavailable; this is not an OCR pass'); return; } throw error; }
  assert.match(material.versions[0].text, /Software Engineer/i);
  assert.equal(material.versions[0].confirmed, false);
  const { source, metadata } = await importer.getSource({ materialId: material.id });
  assert.equal(metadata.ocr.engine, 'windows-media-ocr'); assert.equal(metadata.ocr.width, 1000); assert.equal(metadata.ocr.height, 250);
  assert.ok(metadata.ocr.lines.some(line => line.words.some(word => word.box.width > 0 && word.box.height > 0)));
  assert.deepEqual(await readFile(join(directory, 'files', source.originalFileId)), bytes);
  assert.equal(source.originalHash, createHash('sha256').update(bytes).digest('hex'));
});
