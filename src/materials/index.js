import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ParserSupervisor, DOCUMENT_PARSER_VERSION, createWindowsOcrWorker, checkAcquisitionImage, createHttpJobSource } from './runtime/index.mjs';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const kinds = ['resume', 'job', 'company', 'experience'];
const equal = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export class MaterialImportError extends Error {
  constructor(code, message, original) { super(message); this.name = 'MaterialImportError'; this.code = code; if (original) this.original = original; }
}
const errors = {
  OCR_REQUIRED: '此 PDF 没有足够的文字，请上传页面截图或粘贴原文',
  MATERIALS_OCR_UNAVAILABLE: '当前系统的文字识别不可用，请安装 Windows 识别语言或粘贴原文',
  MATERIALS_OCR_NO_TEXT: '图片中未识别到文字，请使用更清晰的截图或粘贴原文',
  MATERIALS_SITE_VERIFICATION: '页面需要登录或验证，请截图或粘贴你有权查看的原文',
  MATERIALS_NO_JOB_TEXT: '页面中没有可识别的岗位正文，请粘贴原文',
  MATERIALS_URL_REJECTED: '只支持无需登录的公网 HTTP 或 HTTPS 页面',
  MATERIALS_FETCH_TIMEOUT: '读取网页超时，请重试或粘贴原文',
  MATERIALS_ACQUISITION_CANCELLED: '资料导入已取消',
  MATERIALS_CLOSED: '资料导入已关闭',
  MATERIALS_UPLOAD_INVALID: '文件内容或格式无效，请上传 PDF、DOCX、TXT、PNG 或 JPEG',
  MATERIALS_TOO_LARGE: '文件不能超过 25 MiB',
  MATERIALS_TEXT_INVALID: '没有可用文字或正文超过 200000 个字符，请检查原文',
};
function fail(code, original) { throw new MaterialImportError(code, errors[code] ?? '资料读取未完成，请检查文件后重试或粘贴原文', original); }
function failureCode(error, fallback) {
  const candidate = typeof error?.code === 'string' ? error.code : error?.message;
  return typeof candidate === 'string' && /^(?:(?:MATERIALS|DOCUMENT|PARSER|DOCX|PDF|FILE_TYPE)_[A-Z_]+|OCR_REQUIRED)$/.test(candidate) ? candidate : fallback;
}
function cleanText(value) {
  if (typeof value !== 'string') fail('MATERIALS_TEXT_INVALID');
  const text = value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  if (!text.trim() || text.length > 200_000 || text.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) fail('MATERIALS_TEXT_INVALID');
  return text;
}
function description(input) {
  if (!input || !kinds.includes(input.kind)) fail('MATERIALS_UPLOAD_INVALID');
  const raw = input.title || input.filename || '导入资料';
  if (typeof raw !== 'string' || raw.length > 500 || /[\x00-\x1f\x7f]/u.test(raw)) fail('MATERIALS_UPLOAD_INVALID');
  // The original filename is a display label only and never becomes a filesystem path.
  const title = raw.replaceAll('\\', '/').split('/').at(-1).trim().slice(0, 200);
  if (!title) fail('MATERIALS_UPLOAD_INVALID');
  return title;
}
async function ownedDirectory(directory) {
  for (let parent = directory;; parent = dirname(parent)) {
    try {
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !equal(await realpath(parent), parent)) fail('MATERIALS_STORAGE_UNSAFE');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (parent === dirname(parent)) break;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!equal(await realpath(directory), directory)) fail('MATERIALS_STORAGE_UNSAFE');
}
function inspectUpload(input) {
  if (typeof input.dataBase64 !== 'string' || input.dataBase64.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4) fail('MATERIALS_TOO_LARGE');
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (!bytes.length || bytes.toString('base64') !== input.dataBase64) fail('MATERIALS_UPLOAD_INVALID');
  if (bytes.length > MAX_UPLOAD_BYTES) fail('MATERIALS_TOO_LARGE');
  const mime = typeof input.mime === 'string' ? input.mime.toLowerCase().split(';')[0].trim() : '';
  const extension = String(input.filename ?? '').toLowerCase().split('.').at(-1);
  let detected;
  if (bytes.subarray(0, 5).toString() === '%PDF-') detected = { extension: 'pdf', mime: 'application/pdf', type: 'pdf' };
  else if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]))) detected = { extension: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', type: 'docx' };
  else if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes[0] === 255 && bytes[1] === 216) {
    const image = checkAcquisitionImage(bytes);
    detected = { extension: image.mimeType === 'image/png' ? 'png' : 'jpg', mime: image.mimeType, type: 'image' };
  } else if (extension === 'txt' || mime === 'text/plain') detected = { extension: 'txt', mime: 'text/plain', type: 'text' };
  else fail('MATERIALS_UPLOAD_INVALID');
  if (mime && mime !== 'application/octet-stream' && mime !== detected.mime) fail('MATERIALS_UPLOAD_INVALID');
  return { bytes, ...detected };
}

/** Imports only supplied bytes or public pages; no request can name a local source path. */
export function createMaterialImporter({ directory, career }) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('MATERIALS_INVALID_DIRECTORY');
  const root = resolve(directory), files = join(root, 'files');
  const temporary = join(root, 'tmp', 'materials');
  const ready = Promise.all([ownedDirectory(files), ownedDirectory(temporary)]);
  void ready.catch(() => {});
  let supervisor;
  let closed = false;
  const shutdown = new AbortController();
  const pending = new Set();
  const ocr = createWindowsOcrWorker({ root: join(temporary, 'ocr'), scriptPath: fileURLToPath(new URL('./runtime/windows-ocr.ps1', import.meta.url)) });
  const page = createHttpJobSource();
  const check = signal => { if (closed) fail('MATERIALS_CLOSED'); if (signal.aborted) fail('MATERIALS_ACQUISITION_CANCELLED'); };
  const writeMetadata = async (fileId, data) => { await writeFile(join(files, fileId), `${JSON.stringify(data)}\n`, { flag: 'wx', mode: 0o600 }); };

  function run(signal, action) {
    const combined = signal ? AbortSignal.any([shutdown.signal, signal]) : shutdown.signal;
    const work = (async () => { check(combined); await ready; check(combined); return action(combined); })();
    pending.add(work); work.finally(() => pending.delete(work)).catch(() => {});
    return work;
  }

  async function parseDocument(bytes, type, signal) {
    supervisor ??= new ParserSupervisor({ root: join(temporary, 'parser'), childEntry: fileURLToPath(new URL('./runtime/parser-child.mjs', import.meta.url)), nodeExecutable: process.execPath });
    const taskId = randomUUID();
    const cancel = () => { void supervisor.cancel(taskId); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      check(signal);
      const result = await supervisor.submit({ taskId, generation: 1, bytes, documentKind: type, parserVersion: DOCUMENT_PARSER_VERSION });
      check(signal);
      if (result.errorCode) fail(result.errorCode);
      if (result.outcome?.status === 'OCR_REQUIRED') fail('OCR_REQUIRED');
      if (result.outcome?.status !== 'PARSED') fail(result.outcome?.code ?? 'DOCUMENT_UNSAFE');
      return result.outcome.result;
    } finally { signal.removeEventListener('abort', cancel); }
  }

  const upload = (input, { signal } = {}) => run(signal, async scopedSignal => {
    const title = description(input);
    const inspected = inspectUpload(input);
    const fileId = `${randomUUID()}.${inspected.extension}`;
    const metadataFileId = `${randomUUID()}.json`;
    const original = { fileId, hash: digest(inspected.bytes), mime: inspected.mime, bytes: inspected.bytes.length };
    await writeFile(join(files, fileId), inspected.bytes, { flag: 'wx', mode: 0o600 });
    let parsed;
    try {
      if (inspected.type === 'image') {
        const result = await ocr.recognize({ bytes: inspected.bytes, mimeType: inspected.mime }, scopedSignal);
        parsed = { text: cleanText(result.text), method: 'windows-ocr-v1', ocr: result.ocr, requiresConfirmation: true };
      } else if (inspected.type === 'text') {
        parsed = { text: cleanText(new TextDecoder('utf-8', { fatal: true }).decode(inspected.bytes)), method: 'utf8-text-v1', requiresConfirmation: true };
      } else {
        const result = await parseDocument(inspected.bytes, inspected.type, scopedSignal);
        parsed = { text: cleanText(result.plainText), method: 'native-document-parser', document: result, requiresConfirmation: true };
      }
      check(scopedSignal);
      await writeMetadata(metadataFileId, { schemaVersion: 1, status: 'parsed', original, title, kind: input.kind, capturedAt: new Date().toISOString(), ...parsed });
      check(scopedSignal);
      return await career.dispatch('material.add', { title, kind: input.kind, text: parsed.text, source: {
        method: parsed.method, inputKind: inspected.type === 'image' ? 'uploaded-image' : 'uploaded-document',
        originalFileId: fileId, originalHash: original.hash, mime: original.mime, originalBytes: original.bytes,
        metadataFileId, contentHash: digest(parsed.text), requiresConfirmation: true,
        ...(parsed.document ? { parserVersion: parsed.document.parserVersion, pageCount: parsed.document.pageCount, qualityReasons: parsed.document.qualityReasons } : {}),
        ...(parsed.ocr ? { ocrEngine: parsed.ocr.engine, ocrLanguage: parsed.ocr.language, width: parsed.ocr.width, height: parsed.ocr.height } : {}),
      } }, { signal: scopedSignal });
    } catch (error) {
      const code = scopedSignal.aborted ? 'MATERIALS_ACQUISITION_CANCELLED' : failureCode(error, 'MATERIALS_UPLOAD_INVALID');
      try { await writeMetadata(`${randomUUID()}.json`, { schemaVersion: 1, status: 'failed', code, original, title, kind: input.kind }); } catch { /* Original file remains retained even if metadata storage fails. */ }
      throw new MaterialImportError(code, errors[code] ?? '资料读取未完成，请检查文件后重试或粘贴原文', original);
    }
  });

  const fetchUrl = (input, { signal } = {}) => run(signal, async scopedSignal => {
    description(input);
    try {
      const parsed = await page(input.url, scopedSignal);
      check(scopedSignal);
      const text = cleanText(parsed.text);
      const metadataFileId = `${randomUUID()}.json`;
      await writeMetadata(metadataFileId, { schemaVersion: 1, status: 'parsed', ...parsed });
      check(scopedSignal);
      const { method, inputKind, sourceUrl, finalUrl, pageTitle, capturedAt, contentHash } = parsed.source;
      return await career.dispatch('material.add', { title: input.title || parsed.title.slice(0, 200), kind: input.kind, text,
        source: { method, inputKind, sourceUrl, finalUrl, pageTitle, capturedAt, contentHash, metadataFileId, requiresConfirmation: true } }, { signal: scopedSignal });
    } catch (error) {
      const code = scopedSignal.aborted ? 'MATERIALS_ACQUISITION_CANCELLED' : failureCode(error, 'MATERIALS_FETCH_FAILED');
      fail(code);
    }
  });

  async function storedFile(fileId, limit) {
    if (typeof fileId !== 'string' || !/^[a-f0-9-]{36}\.(?:pdf|docx|txt|png|jpg|json)$/.test(fileId)) fail('MATERIALS_SOURCE_NOT_FOUND');
    const file = join(files, fileId);
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > limit || !equal(await realpath(file), file)) fail('MATERIALS_SOURCE_NOT_FOUND');
    const handle = await open(file, 'r');
    try {
      const opened = await handle.stat();
      if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size || opened.nlink !== 1) fail('MATERIALS_SOURCE_NOT_FOUND');
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) fail('MATERIALS_SOURCE_NOT_FOUND'); offset += bytesRead; }
      if ((await handle.stat()).size !== opened.size) fail('MATERIALS_SOURCE_NOT_FOUND');
      return bytes;
    } finally { await handle.close(); }
  }
  async function sourceVersion(input) {
    if (!input || typeof (input.versionId ?? input.materialId) !== 'string') fail('MATERIALS_SOURCE_NOT_FOUND');
    const state = await career.dispatch('state');
    const material = state.materials.find(row => input.materialId ? row.id === input.materialId : row.versions.some(version => version.id === input.versionId));
    const version = material?.versions.find(row => row.id === (input.versionId ?? material.latestVersionId));
    if (!version?.source?.metadataFileId) fail('MATERIALS_SOURCE_NOT_FOUND');
    let metadata;
    try { metadata = JSON.parse((await storedFile(version.source.metadataFileId, 8 * 1024 * 1024)).toString('utf8')); }
    catch { fail('MATERIALS_SOURCE_NOT_FOUND'); }
    if (metadata.status !== 'parsed' || digest(metadata.text) !== version.source.contentHash || version.hash !== digest(metadata.text)) fail('MATERIALS_SOURCE_NOT_FOUND');
    return { material, version, metadata };
  }
  const getSource = (input, { signal } = {}) => run(signal, async scopedSignal => {
    const { material, version, metadata } = await sourceVersion(input);
    check(scopedSignal);
    return { materialId: material.id, versionId: version.id, title: material.title, source: version.source, metadata };
  });
  const getOriginal = (input, { signal } = {}) => run(signal, async scopedSignal => {
    const { material, version, metadata } = await sourceVersion(input);
    const original = metadata.original;
    if (!original || original.fileId !== version.source.originalFileId || original.hash !== version.source.originalHash) fail('MATERIALS_SOURCE_NOT_FOUND');
    let bytes;
    try { bytes = await storedFile(original.fileId, MAX_UPLOAD_BYTES); } catch { fail('MATERIALS_SOURCE_NOT_FOUND'); }
    check(scopedSignal);
    if (digest(bytes) !== original.hash || !['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'image/png', 'image/jpeg'].includes(original.mime)) fail('MATERIALS_SOURCE_NOT_FOUND');
    return { bytes, mime: original.mime, filename: `${material.title.replace(/[\\/:*?"<>|]/g, '_')}.${original.fileId.split('.').at(-1)}` };
  });
  let closing;
  function close() {
    if (closing) return closing;
    closed = true; shutdown.abort();
    return closing = Promise.allSettled([supervisor?.close(), ocr.close(), ...pending]).then(() => {});
  }
  return { upload, fetchUrl, getSource, getOriginal, close };
}
