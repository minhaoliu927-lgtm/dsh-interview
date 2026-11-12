import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MaterialOcrResultSchema, type MaterialOcrResult } from '../contracts/material-source.ts';
import { Value } from '@sinclair/typebox/value';

import { checkAcquisitionImage, type AcquisitionImageMime } from './image-policy.ts';

export interface WindowsOcrOptions {
  root: string; scriptPath?: string; timeoutMs?: number; outputLimit?: number; language?: string;
  onProcess?: (evidence: WindowsOcrProcessEvidence) => void;
  /** Explicit bounded executable/source substitution is available to trusted Node tests only. */
  testOnly?: { executable: string; arguments?: string[]; onSpawn?: (pid: number) => void };
}
export interface WindowsOcrProcessEvidence { pid?: number; exitCode: number | null; stdoutBytes: number; stderrBytes: number;
  cleaned: boolean; stopped: boolean; windowsHide: true; modelRequests: 0 }
interface Job { child?: ChildProcess; stop: () => void; completion: Promise<{ text: string; ocr: MaterialOcrResult }> }
const quote = (text: string) => "'" + text.replaceAll("'", "''") + "'";
const failure = (code = 'MATERIALS_OCR_FAILED') => new Error(code);
const equalPath = (one: string, two: string) => process.platform === 'win32' ? one.toLowerCase() === two.toLowerCase() : one === two;
function safeDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || /[\u0000-\u001f]/u.test(directory)) throw failure();
  for (let parent = directory;; parent = path.dirname(parent)) {
    if (fs.existsSync(parent)) {
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !equalPath(fs.realpathSync.native(parent), parent)) throw failure();
    }
    if (path.dirname(parent) === parent) break;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!equalPath(fs.realpathSync.native(directory), directory) || fs.lstatSync(directory).isSymbolicLink()) throw failure();
}
function decodeOutput(raw: Buffer, expected: { width: number; height: number }): { text: string; ocr: MaterialOcrResult } {
  let result: Record<string, unknown>;
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^\uFEFF/u, '').trim()) as Record<string, unknown>; }
  catch { throw failure(); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw failure();
  if (result.ok === false) {
    throw failure(['MATERIALS_OCR_UNAVAILABLE', 'MATERIALS_IMAGE_REJECTED'].includes(String(result.code)) ? String(result.code) : undefined);
  }
  if (result.ok !== true || result.width !== expected.width || result.height !== expected.height
    || typeof result.language !== 'string' || !Array.isArray(result.lines) || result.lines.length > 10000) throw failure();
  if (!result.lines.length) throw failure('MATERIALS_OCR_NO_TEXT');
  const lines: MaterialOcrResult['lines'] = []; let text = '';
  for (const value of result.lines) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(); const line = value as Record<string, unknown>;
    if (typeof line.text !== 'string' || !line.text.trim() || line.text.length > 10000 || /[\r\n\u0000]/u.test(line.text)
      || !Array.isArray(line.words) || !line.words.length || line.words.length > 1000) throw failure();
    const words: MaterialOcrResult['lines'][number]['words'] = [];
    for (const item of line.words) {
      if (!item || typeof item !== 'object') throw failure(); const word = item as Record<string, unknown>;
      if (typeof word.text !== 'string' || !word.text || word.text.length > 1000 || !line.text.includes(word.text)
        || !word.box || typeof word.box !== 'object') throw failure();
      const box = word.box as Record<string, unknown>, fields = ['x', 'y', 'width', 'height'] as const;
      if (fields.some(key => typeof box[key] !== 'number' || !Number.isFinite(box[key]))) throw failure();
      const rectangle = box as { x: number; y: number; width: number; height: number };
      if (rectangle.x < 0 || rectangle.y < 0 || rectangle.width <= 0 || rectangle.height <= 0
        || rectangle.x + rectangle.width > expected.width + 0.01 || rectangle.y + rectangle.height > expected.height + 0.01) throw failure();
      words.push({ text: word.text, box: { ...rectangle } });
    }
    if (text) text += '\n'; const startOffset = text.length; text += line.text; if (text.length > 200000) throw failure();
    const left = Math.min(...words.map(word => word.box.x)), top = Math.min(...words.map(word => word.box.y));
    const right = Math.max(...words.map(word => word.box.x + word.box.width)), bottom = Math.max(...words.map(word => word.box.y + word.box.height));
    lines.push({ text: line.text, startOffset, endOffset: text.length, box: { x: left, y: top, width: right - left, height: bottom - top }, words });
  }
  const ocr: MaterialOcrResult = { engine: 'windows-media-ocr', language: result.language, width: expected.width, height: expected.height, lines };
  try { if (!Value.Check(MaterialOcrResultSchema, ocr)) throw failure(); } catch { throw failure(); }
  return { text, ocr };
}

/** A trusted, hidden, one-shot WinRT worker; images never enter a shell command or vendor request. */
export function createWindowsOcrWorker(options: WindowsOcrOptions) {
  const root = path.resolve(options.root), timeoutMs = options.timeoutMs ?? 30000, outputLimit = options.outputLimit ?? 4 * 1024 * 1024;
  const language = options.language ?? 'auto';
  if (!path.isAbsolute(options.root) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000
    || !Number.isSafeInteger(outputLimit) || outputLimit < 1024 || outputLimit > 8 * 1024 * 1024 || !/^[A-Za-z0-9-]{2,40}$/u.test(language)) throw failure();
  let closed = false; const jobs = new Set<Job>(); let closing: Promise<void> | undefined;
  return {
    recognize(input: { bytes: Uint8Array; mimeType: AcquisitionImageMime }, signal: AbortSignal) {
      if (closed) return Promise.reject(failure('MATERIALS_CLOSED'));
      if (signal.aborted) return Promise.reject(failure('MATERIALS_ACQUISITION_CANCELLED'));
      if (jobs.size >= 2) return Promise.reject(failure());
      const bytes = Buffer.from(input.bytes), dimensions = checkAcquisitionImage(bytes, input.mimeType);
      const inputHash = createHash('sha256').update(bytes).digest('hex');
      if (process.platform !== 'win32' && !options.testOnly) return Promise.reject(failure('MATERIALS_OCR_UNAVAILABLE'));
      let jobDirectory: string, inputPath: string, inputIdentity: fs.Stats, directoryIdentity: fs.Stats;
      try {
        safeDirectory(root); jobDirectory = path.join(root, randomUUID()); fs.mkdirSync(jobDirectory, { mode: 0o700 });
        directoryIdentity = fs.lstatSync(jobDirectory); inputPath = path.join(jobDirectory, 'input.bin');
        fs.writeFileSync(inputPath, bytes, { flag: 'wx', mode: 0o600 }); inputIdentity = fs.lstatSync(inputPath);
      } catch { return Promise.reject(failure()); }
      let child: ChildProcess | undefined, stopped: string | undefined;
      let settle!: (result: { text: string; ocr: MaterialOcrResult }) => void, reject!: (error: Error) => void;
      const completion = new Promise<{ text: string; ocr: MaterialOcrResult }>((resolve, failed) => { settle = resolve; reject = failed; });
      const stop = (code: string) => { stopped ??= code; if (child && child.exitCode === null && child.signalCode === null) child.kill(); };
      const job: Job = { stop: () => stop('MATERIALS_ACQUISITION_CANCELLED'), completion }; jobs.add(job);
      const cancel = () => stop('MATERIALS_ACQUISITION_CANCELLED'); signal.addEventListener('abort', cancel, { once: true });
      const stdout: Buffer[] = []; let stdoutBytes = 0, stderrBytes = 0, finished = false;
      const cleanup = () => {
        const relative = path.relative(root, jobDirectory);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !equalPath(fs.realpathSync.native(jobDirectory), jobDirectory)) throw failure();
        const directory = fs.lstatSync(jobDirectory), original = fs.lstatSync(inputPath);
        if (directory.isSymbolicLink() || directory.dev !== directoryIdentity.dev || directory.ino !== directoryIdentity.ino
          || !original.isFile() || original.isSymbolicLink() || original.nlink !== 1 || original.dev !== inputIdentity.dev || original.ino !== inputIdentity.ino) throw failure();
        const entries = fs.readdirSync(jobDirectory); if (entries.some(entry => entry !== 'input.bin') || original.size !== bytes.length) throw failure();
        // Recheck immutable copied bytes with a bounded handle before unlinking the worker input.
        const fd = fs.openSync(inputPath, 'r'), checked = Buffer.alloc(bytes.length);
        try {
          const opened = fs.fstatSync(fd); if (opened.dev !== inputIdentity.dev || opened.ino !== inputIdentity.ino || opened.nlink !== 1 || opened.size !== bytes.length) throw failure();
          let offset = 0; while (offset < checked.length) { const read = fs.readSync(fd, checked, offset, checked.length - offset, offset); if (!read) throw failure(); offset += read; }
          if (fs.readSync(fd, Buffer.alloc(1), 0, 1, checked.length) !== 0 || createHash('sha256').update(checked).digest('hex') !== inputHash) throw failure();
        } finally { fs.closeSync(fd); }
        fs.unlinkSync(inputPath); fs.rmdirSync(jobDirectory);
      };
      const finish = (code: number | null) => {
        if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); jobs.delete(job);
        let result: { text: string; ocr: MaterialOcrResult } | undefined, error: Error | undefined;
        try { if (stopped) throw failure(stopped); result = decodeOutput(Buffer.concat(stdout), dimensions); if (code !== 0) throw failure(); }
        catch (cause) { error = cause instanceof Error ? cause : failure(); }
        let cleaned = false; try { cleanup(); cleaned = true; } catch { error = failure(); }
        try { options.onProcess?.({ ...(child?.pid ? { pid: child.pid } : {}), exitCode: code, stdoutBytes, stderrBytes, cleaned,
          stopped: !!stopped, windowsHide: true, modelRequests: 0 }); } catch { /* Evidence hooks never publish an OCR candidate. */ }
        if (error || !result) reject(error ?? failure()); else settle(result);
      };
      const timer = setTimeout(() => stop('MATERIALS_OCR_FAILED'), timeoutMs);
      try {
        const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
        const source = fs.readFileSync(options.scriptPath ?? fileURLToPath(new URL('./windows-ocr.ps1', import.meta.url)), 'utf8').replace(/^\uFEFF/u, '');
        const command = `$ocrInputPath=${quote(inputPath)}; $ocrLanguage=${quote(language)};\n${source}`;
        const executable = options.testOnly?.executable ?? path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const args = options.testOnly?.arguments ?? ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
        child = spawn(executable, args, { cwd: jobDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: root, TMP: root } }); job.child = child;
        child.stdout?.on('data', (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes > outputLimit) stop('MATERIALS_OCR_FAILED'); else stdout.push(chunk); });
        child.stderr?.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 65536) stop('MATERIALS_OCR_FAILED'); });
        child.once('error', () => { stopped ??= 'MATERIALS_OCR_UNAVAILABLE'; }); child.once('close', code => finish(code));
        if (child.pid) { try { options.testOnly?.onSpawn?.(child.pid); } catch { stop('MATERIALS_OCR_FAILED'); } }
        if (signal.aborted || closed) cancel();
      } catch { stopped ??= 'MATERIALS_OCR_UNAVAILABLE'; finish(null); }
      return completion;
    },
    close() {
      if (closing) return closing; closed = true; const own = [...jobs]; for (const job of own) job.stop();
      return closing = Promise.allSettled(own.map(job => job.completion)).then(() => {});
    },
  };
}
