import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ParseDocumentKind, ParseDocumentOutcome } from '../../contracts/documents.ts';
import { DOCUMENT_PARSER_VERSION, MAX_FILE_SIZE_BYTES } from '../../domain/document-limits.ts';
import { parserEnvironment, parserNodeArguments } from './environment.ts';
import { resolveSupervisorLimits, type SupervisorLimits } from './limits.ts';
import { CHILD_REQUEST_MAX_BYTES, CHILD_SCHEMA_VERSION, decodeChildReply, isTaskIdentity, TASK_ID_PATTERN, type ChildRequest } from './protocol.ts';
import { recoverParserStaging, secureParserDirectory, spawnParserProcess } from './platform.ts';

export { DEFAULT_SUPERVISOR_LIMITS, resolveSupervisorLimits, type SupervisorLimits } from './limits.ts';
export type SupervisorErrorCode = 'PARSER_TIMEOUT' | 'PARSER_CANCELLED' | 'PARSER_OUTPUT_LIMIT' | 'PARSER_INVALID_REPLY'
  | 'PARSER_ABNORMAL_EXIT' | 'PARSER_QUEUE_FULL' | 'PARSER_CLOSED' | 'PARSER_START_FAILED' | 'PARSER_TEMP_FAILED' | 'PARSER_CLEANUP_PENDING';
export interface ParserSubmission {
  taskId: string;
  generation: number;
  bytes: Uint8Array;
  documentKind: ParseDocumentKind;
  parserVersion: string;
}
export interface ProcessEvidence {
  tempId: string;
  pid?: number;
  childPid?: number;
  exitCode?: number | null;
  signal?: string | null;
  terminated: boolean;
  cleaned: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  permissionModel: 'node-read-only-code-and-private-input';
  nativeAddonsAllowed: true;
  platform?: unknown;
  acl?: unknown;
  startupPhase?: 'private-directory' | 'process-start' | 'running';
}
export interface SupervisorResult {
  outcome?: ParseDocumentOutcome;
  errorCode?: SupervisorErrorCode;
  processEvidence: ProcessEvidence;
}
export interface ParserSupervisorOptions {
  root: string;
  childEntry: string;
  nodeExecutable: string;
  limits?: Partial<SupervisorLimits>;
  /** Trusted Node tests only. Desktop construction never supplies these hooks. */
  testOnly?: {
    onSpawn?: (value: { taskId: string; tempId: string; pid?: number }) => void;
    onPhase?: (value: { taskId: string; tempId: string; phase: NonNullable<ProcessEvidence['startupPhase']> }) => void;
  };
}
interface Job {
  submission: ParserSubmission;
  tempId: string;
  controller: AbortController;
  state: 'queued' | 'running';
  promise: Promise<SupervisorResult>;
  finish: (result: SupervisorResult) => void;
}
interface OwnedManifest {
  schemaVersion: 'zhijing-parser-job/v1';
  owner: '@zhijing/document-parser';
  tempId: string;
  taskId: string;
  generation: number;
  parserVersion: string;
  input: 'input.bin';
  createdAt: number;
  pid?: number;
}
const PLATFORM_ENTRIES = new Set(['_platform-config.json', '_platform-receipt.json', '_platform-receipt.json.next', '_platform-compile']);

export class ParserSupervisor {
  readonly limits: Readonly<SupervisorLimits>;
  private readonly options: ParserSupervisorOptions;
  private readonly ready: Promise<string>;
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private running = 0;
  private closed = false;

  constructor(options: ParserSupervisorOptions) {
    if (!options || ![options.root, options.childEntry, options.nodeExecutable].every(value => typeof value === 'string' && isAbsolute(value))) throw new Error('PARSER_INVALID_CONFIG');
    const root = resolve(options.root), entry = realpathSync(options.childEntry), node = realpathSync(options.nodeExecutable);
    if (dirname(root) === root || !lstatSync(entry).isFile() || !lstatSync(node).isFile()
      || node !== realpathSync(process.execPath) || !/\.(?:mjs|ts)$/u.test(entry)) throw new Error('PARSER_INVALID_CONFIG');
    this.options = { ...options, root, childEntry: entry, nodeExecutable: node };
    this.limits = resolveSupervisorLimits(options.limits);
    this.ready = this.initializeRoot(root);
    // A construction-time FS problem is reported by submissions/recovery, not unhandled rejection.
    void this.ready.catch(() => {});
  }

  submit(submission: ParserSubmission): Promise<SupervisorResult> {
    const evidence = freshEvidence(randomUUID());
    if (this.closed) return Promise.resolve({ errorCode: 'PARSER_CLOSED', processEvidence: evidence });
    if (!submission || !isTaskIdentity(submission.taskId, submission.generation) || !(submission.bytes instanceof Uint8Array)
      || !['pdf', 'docx', 'image'].includes(submission.documentKind) || submission.parserVersion !== DOCUMENT_PARSER_VERSION
      || this.jobs.has(submission.taskId)) return Promise.resolve({ errorCode: 'PARSER_INVALID_REPLY', processEvidence: evidence });
    if (submission.bytes.byteLength > MAX_FILE_SIZE_BYTES) return Promise.resolve({ outcome: { status: 'FAILED', code: 'DOCUMENT_TOO_LARGE' }, processEvidence: evidence });
    if (this.running >= this.limits.concurrency && this.queue.length >= this.limits.queueLimit) return Promise.resolve({ errorCode: 'PARSER_QUEUE_FULL', processEvidence: evidence });
    let finish!: Job['finish'];
    const promise = new Promise<SupervisorResult>(resolveResult => { finish = resolveResult; });
    const job: Job = { submission: { ...submission, bytes: Buffer.from(submission.bytes) }, tempId: evidence.tempId,
      controller: new AbortController(), state: 'queued', promise, finish };
    this.jobs.set(submission.taskId, job); this.queue.push(job); this.pump();
    return promise;
  }

  async cancel(taskId: string): Promise<void> {
    const job = this.jobs.get(taskId);
    if (!job) return;
    job.controller.abort();
    if (job.state === 'queued') {
      const index = this.queue.indexOf(job); if (index >= 0) this.queue.splice(index, 1);
      this.jobs.delete(taskId);
      job.finish({ errorCode: 'PARSER_CANCELLED', processEvidence: freshEvidence(job.tempId) });
    }
    await job.promise;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.jobs.keys()].map(taskId => this.cancel(taskId)));
  }

  async recover(): Promise<{ recovered: number; pending: string[] }> {
    const root = await this.ready;
    const staging = await recoverParserStaging(root);
    let recovered = staging.removed.length;
    const pending = new Set(staging.pending);
    const active = new Set([...this.jobs.values()].map(job => job.tempId));
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (active.has(entry.name)) continue;
      // Platform staging has its own ownership and process-identity rules.
      if (pending.has(entry.name)) continue;
      const directory = join(root, entry.name);
      try {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !TASK_ID_PATTERN.test(entry.name) || await realpath(directory) !== directory) throw new Error('unknown');
        const manifestFile = join(directory, 'owner.json');
        if ((await lstat(manifestFile)).isSymbolicLink()) throw new Error('linked');
        const bytes = await readFile(manifestFile);
        if (bytes.length > 8192) throw new Error('large');
        const manifest: unknown = JSON.parse(bytes.toString('utf8'));
        if (!isOwnedManifest(manifest, entry.name) || manifest.pid && processAlive(manifest.pid)) throw new Error('live-or-unknown');
        await assertSafeOwnedTree(directory, true);
        await rm(directory, { recursive: true, force: true });
        recovered += 1;
      } catch { pending.add(entry.name); }
    }
    return { recovered, pending: [...pending].sort() };
  }

  private async initializeRoot(root: string): Promise<string> {
    // Every existing ancestor is checked before creating the controlled leaf.
    const missing: string[] = [];
    let ancestor = root;
    while (!existsSync(ancestor)) { missing.push(ancestor); ancestor = dirname(ancestor); }
    let current = ancestor;
    for (;;) {
      if (lstatSync(current).isSymbolicLink()) throw new Error('PARSER_TEMP_FAILED');
      if (dirname(current) === current) break;
      current = dirname(current);
    }
    for (const directory of missing.reverse()) await mkdir(directory, { mode: 0o700 });
    if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error('PARSER_TEMP_FAILED');
    return realpath(root);
  }

  private pump(): void {
    while (!this.closed && this.running < this.limits.concurrency && this.queue.length) {
      const job = this.queue.shift()!; job.state = 'running'; this.running += 1;
      void this.run(job).then(job.finish, () => job.finish({ errorCode: 'PARSER_TEMP_FAILED', processEvidence: freshEvidence(job.tempId) }))
        .finally(() => { this.jobs.delete(job.submission.taskId); this.running -= 1; this.pump(); });
    }
  }

  private async run(job: Job): Promise<SupervisorResult> {
    const evidence = freshEvidence(job.tempId);
    let directory: string | undefined;
    let handle: Awaited<ReturnType<typeof spawnParserProcess>> | undefined;
    let termination: Promise<void> | undefined;
    let errorCode: SupervisorErrorCode | undefined;
    let outcome: ParseDocumentOutcome | undefined;
    let created = false;
    let directoryAttempted = false;
    const terminate = (): Promise<void> => {
      if (!handle) return Promise.resolve();
      termination ??= handle.terminate().then(() => { evidence.terminated = true; });
      return termination!;
    };
    const stop = (code: SupervisorErrorCode): void => {
      errorCode ??= code;
      // Lock the initiating reason before abort listeners observe the shared signal.
      if (!job.controller.signal.aborted) job.controller.abort();
      void terminate().catch(() => {});
    };
    const phase = (value: NonNullable<ProcessEvidence['startupPhase']>): void => {
      evidence.startupPhase = value;
      this.options.testOnly?.onPhase?.({ taskId: job.submission.taskId, tempId: job.tempId, phase: value });
    };
    const onAbort = (): void => stop('PARSER_CANCELLED');
    job.controller.signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => stop('PARSER_TIMEOUT'), this.limits.timeoutMs);
    try {
      const root = await this.ready;
      directory = join(root, job.tempId);
      if (job.controller.signal.aborted) stop('PARSER_CANCELLED');
      if (errorCode) throw new Error('PARSER_STOPPED');
      if (existsSync(directory)) throw new Error('PARSER_TEMP_FAILED');
      directoryAttempted = true; evidence.cleaned = false; phase('private-directory');
      evidence.acl = await secureParserDirectory(directory, { signal: job.controller.signal }); created = true;
      const inputPath = join(directory, 'input.bin');
      const manifest: OwnedManifest = { schemaVersion: 'zhijing-parser-job/v1', owner: '@zhijing/document-parser', tempId: job.tempId,
        taskId: job.submission.taskId, generation: job.submission.generation, parserVersion: job.submission.parserVersion, input: 'input.bin', createdAt: Date.now() };
      await writeFile(join(directory, 'owner.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
      await writeFile(inputPath, job.submission.bytes, { mode: 0o600, flag: 'wx' });
      job.submission.bytes = new Uint8Array();
      if (errorCode) throw new Error('PARSER_STOPPED');
      const request: ChildRequest = { schemaVersion: CHILD_SCHEMA_VERSION, taskId: job.submission.taskId, generation: job.submission.generation,
        inputPath, documentKind: job.submission.documentKind, parserVersion: job.submission.parserVersion };
      const requestBytes = Buffer.from(JSON.stringify(request));
      if (requestBytes.length > CHILD_REQUEST_MAX_BYTES) throw new Error('request');
      try {
        phase('process-start');
        handle = await spawnParserProcess({ nodeExecutable: this.options.nodeExecutable, entryPoint: this.options.childEntry,
          args: parserNodeArguments(this.options.childEntry, directory, this.limits.heapMb), cwd: directory,
          env: parserEnvironment(directory), jobMemoryMb: this.limits.jobMemoryMb, signal: job.controller.signal });
      } catch { stop('PARSER_START_FAILED'); }
      if (!handle) throw new Error('PARSER_STOPPED');
      const child = handle.process;
      evidence.pid = child.pid; evidence.platform = handle.metadata; evidence.terminated = false;
      phase('running');
      manifest.pid = child.pid;
      await writeFile(join(directory, 'owner.json'), JSON.stringify(manifest), { mode: 0o600 });
      const chunks: Buffer[] = [];
      await new Promise<void>(resolveExit => {
        let closed = child.exitCode !== null || child.signalCode !== null;
        const done = (): void => {
          if (closed && (child.stdout.readableEnded || child.stdout.destroyed) && (child.stderr.readableEnded || child.stderr.destroyed)) resolveExit();
        };
        child.stdout.on('data', (chunk: Buffer) => {
          evidence.stdoutBytes += chunk.length;
          if (evidence.stdoutBytes > this.limits.stdoutMaxBytes) stop('PARSER_OUTPUT_LIMIT');
          else chunks.push(Buffer.from(chunk));
        });
        child.stderr.on('data', (chunk: Buffer) => { evidence.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, evidence.stderrBytes + chunk.length); });
        child.stdout.once('end', done); child.stderr.once('end', done);
        child.stdout.once('close', done); child.stderr.once('close', done);
        child.once('error', () => stop('PARSER_START_FAILED'));
        child.once('close', () => { closed = true; done(); });
        child.stdin.on('error', () => {});
        child.stdin.end(requestBytes);
        this.options.testOnly?.onSpawn?.({ taskId: job.submission.taskId, tempId: job.tempId, pid: child.pid });
        if (errorCode) void terminate().catch(() => {});
        setImmediate(done);
      });
      evidence.exitCode = child.exitCode; evidence.signal = child.signalCode;
      if (job.controller.signal.aborted) stop('PARSER_CANCELLED');
      if (!errorCode && child.exitCode !== 0) stop('PARSER_ABNORMAL_EXIT');
      if (!errorCode) {
        try { outcome = decodeChildReply(Buffer.concat(chunks), request); }
        catch { stop('PARSER_INVALID_REPLY'); }
      }
    } catch { errorCode ??= 'PARSER_TEMP_FAILED'; }
    finally {
      clearTimeout(timeout); job.controller.signal.removeEventListener('abort', onAbort);
      let terminationConfirmed = true;
      try { await terminate(); } catch { terminationConfirmed = false; evidence.terminated = false; errorCode = 'PARSER_CLEANUP_PENDING'; }
      if (terminationConfirmed) {
        try { await handle?.cleanup(); } catch { errorCode = 'PARSER_CLEANUP_PENDING'; }
      }
      const childPid = handle?.metadata.childPid;
      if (typeof childPid === 'number' && Number.isSafeInteger(childPid)) evidence.childPid = childPid;
      if (directoryAttempted && directory) {
        try {
          if (!terminationConfirmed) throw new Error('live');
          if (created) { await assertSafeOwnedTree(directory, false); await rm(directory, { recursive: true, force: true }); }
          else if (existsSync(directory)) {
            // ACL setup can create a directory before aborting. Without its owner manifest,
            // only an empty, nonlinked candidate may be removed, never a recursive unknown tree.
            const stat = await lstat(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory || (await readdir(directory)).length) throw new Error('unknown');
            await rmdir(directory);
          }
        } catch { errorCode = 'PARSER_CLEANUP_PENDING'; }
        try {
          await lstat(directory); evidence.cleaned = false; errorCode = 'PARSER_CLEANUP_PENDING';
        } catch (error) {
          evidence.cleaned = (error as NodeJS.ErrnoException).code === 'ENOENT';
          if (!evidence.cleaned) errorCode = 'PARSER_CLEANUP_PENDING';
        }
      }
    }
    return { ...(errorCode ? { errorCode } : { outcome }), processEvidence: evidence };
  }
}

function freshEvidence(tempId: string): ProcessEvidence {
  return { tempId, terminated: true, cleaned: true, stdoutBytes: 0, stderrBytes: 0,
    permissionModel: 'node-read-only-code-and-private-input', nativeAddonsAllowed: true };
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function isOwnedManifest(value: unknown, tempId: string): value is OwnedManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'owner', 'tempId', 'taskId', 'generation', 'parserVersion', 'input', 'createdAt', ...(item.pid === undefined ? [] : ['pid'])];
  return Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key))
    && item.schemaVersion === 'zhijing-parser-job/v1' && item.owner === '@zhijing/document-parser' && item.tempId === tempId
    && isTaskIdentity(item.taskId, item.generation) && item.parserVersion === DOCUMENT_PARSER_VERSION && item.input === 'input.bin'
    && Number.isSafeInteger(item.createdAt) && Number(item.createdAt) > 0
    && (item.pid === undefined || Number.isSafeInteger(item.pid) && Number(item.pid) > 0);
}
async function assertSafeOwnedTree(directory: string, recovery: boolean): Promise<void> {
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('linked');
  for (const name of await readdir(directory)) {
    if (name !== 'input.bin' && name !== 'owner.json' && !(recovery && PLATFORM_ENTRIES.has(name))) throw new Error('unknown');
    const file = join(directory, name), stat = await lstat(file);
    const rel = relative(directory, file);
    if (rel.startsWith(`..${sep}`) || isAbsolute(rel) || stat.isSymbolicLink()) throw new Error('linked');
    if (stat.isDirectory()) {
      if (!recovery || name !== '_platform-compile') throw new Error('unknown');
      await assertBoundedRegularTree(file, 0, { count: 0 });
    } else if (!stat.isFile()) throw new Error('nonregular');
  }
}
async function assertBoundedRegularTree(directory: string, depth: number, counter: { count: number }): Promise<void> {
  if (depth > 8) throw new Error('deep');
  for (const name of await readdir(directory)) {
    if (++counter.count > 1000) throw new Error('large');
    const file = join(directory, name), stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error('linked');
    if (stat.isDirectory()) await assertBoundedRegularTree(file, depth + 1, counter);
    else if (!stat.isFile()) throw new Error('nonregular');
  }
}
