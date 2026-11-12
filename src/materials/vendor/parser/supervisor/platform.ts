import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface ParserProcessOptions {
  nodeExecutable: string; entryPoint: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; jobMemoryMb?: number; signal?: AbortSignal;
}
export interface ParserPlatformProcess {
  process: ChildProcessWithoutNullStreams;
  terminate(): Promise<void>;
  cleanup(): Promise<void>;
  metadata: Record<string, unknown>;
}
const configName = '_platform-config.json', receiptName = '_platform-receipt.json', compileName = '_platform-compile';
function fail(code = 'PARSER_PLATFORM_FAILED'): never { throw new Error(code); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) fail('PARSER_PLATFORM_ABORTED'); }
function absolute(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f]/u.test(value)) fail('PARSER_PLATFORM_PATH_INVALID');
  return path.resolve(value);
}
function directory(value: string): string {
  const full = absolute(value), stat = fs.lstatSync(full);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(full) !== full) fail('PARSER_PLATFORM_PATH_INVALID');
  return full;
}
function regular(value: string): string {
  const full = absolute(value), stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync.native(full) !== full) fail('PARSER_PLATFORM_PATH_INVALID');
  return full;
}
function resourceDirectory(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [here, path.join(here, 'supervisor')]) {
    if (fs.existsSync(path.join(candidate, 'windows-job.ps1')) && fs.existsSync(path.join(candidate, 'windows-job.cs'))) {
      regular(path.join(candidate, 'windows-job.ps1')); regular(path.join(candidate, 'windows-job.cs')); return candidate;
    }
  }
  return fail('PARSER_PLATFORM_RESOURCES_MISSING');
}
function psLiteral(value: string): string { return "'" + value.replaceAll("'", "''") + "'"; }
function windowsCommand(mode: string, values: Record<string, string>, identityFile?: string): { executable: string; args: string[] } {
  const resources = resourceDirectory(), system = process.env.SystemRoot ?? 'C:\\Windows';
  const executable = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const identity = identityFile ? "$self=[Diagnostics.Process]::GetCurrentProcess();$epoch=[DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc);"
    + '$identity=@{schema=1;pid=$PID;createdUtcMs=[long](($self.StartTime.ToUniversalTime()-$epoch).TotalMilliseconds)}|ConvertTo-Json -Compress;'
    + '[IO.File]::WriteAllText(' + psLiteral(identityFile + '.next') + ',$identity);[IO.File]::Move(' + psLiteral(identityFile + '.next') + ',' + psLiteral(identityFile) + ');' : '';
  const command = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); " + identity + " & ([ScriptBlock]::Create([IO.File]::ReadAllText("
    + psLiteral(path.join(resources, 'windows-job.ps1')) + '))) -Mode ' + psLiteral(mode) + ' -ResourceDirectory ' + psLiteral(resources)
    + Object.entries(values).map(([name, value]) => ' -' + name + ' ' + psLiteral(value)).join('');
  return { executable, args: ['-NoProfile', '-NonInteractive', '-Command', command] };
}
function wrapperEnvironment(temp: string): NodeJS.ProcessEnv {
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  return { SystemRoot: system, WINDIR: system, PATH: path.join(system, 'System32'), TEMP: temp, TMP: temp,
    USERPROFILE: temp, APPDATA: temp, LOCALAPPDATA: temp };
}
/** Only this owned ChildProcess's exact PID tree; retain a native process handle while checking identity and invoking taskkill. */
async function stopWindowsTree(child: ChildProcessWithoutNullStreams, executable: string, bornBefore: number, bornAfter: number,
  cwd: string, temp: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await stopWindowsIdentity(child.pid, executable, bornBefore, bornAfter, cwd, temp);
}
async function stopWindowsIdentity(pid: number, executable: string, bornBefore: number, bornAfter: number, cwd: string, temp: string): Promise<void> {
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  const script = "$ErrorActionPreference='Stop'; try{$owned=[Diagnostics.Process]::GetProcessById(" + pid + ")}catch [ArgumentException]{exit 0};try{"
    + "$null=$owned.Handle;if($owned.HasExited){exit 0};$epoch=[DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc);$created=[long](($owned.StartTime.ToUniversalTime()-$epoch).TotalMilliseconds);"
    + 'if($created-lt ' + (bornBefore - 2) + '-or $created-gt ' + (bornAfter + 2) + "){throw 'OWNED_PROCESS_IDENTITY_CHANGED'};"
    + "try{$actualExecutable=$owned.MainModule.FileName}catch{if($owned.HasExited){exit 0};throw};if($actualExecutable-ne " + psLiteral(executable) + "){throw 'OWNED_PROCESS_EXECUTABLE_CHANGED'};if(-not $owned.HasExited){"
    + '$killer=New-Object Diagnostics.Process;$killer.StartInfo.FileName=' + psLiteral(path.join(system, 'System32/taskkill.exe'))
    + ";$killer.StartInfo.Arguments='/PID " + pid + " /T /F';$killer.StartInfo.UseShellExecute=$false;$killer.StartInfo.CreateNoWindow=$true;"
    + '$killer.StartInfo.RedirectStandardOutput=$true;$killer.StartInfo.RedirectStandardError=$true;try{$null=$killer.Start();$null=$killer.StandardOutput.ReadToEnd();$null=$killer.StandardError.ReadToEnd();'
    + "if(-not $killer.WaitForExit(10000)){$killer.Kill();throw 'OWNED_TREE_TERMINATION_TIMEOUT'};if($killer.ExitCode-ne 0-and -not $owned.HasExited){throw 'OWNED_TREE_TERMINATION_FAILED'}}finally{$killer.Dispose()}};"
    + "if(-not $owned.WaitForExit(10000)){throw 'OWNED_PROCESS_STILL_RUNNING'}}finally{$owned.Dispose()}";
  const probe = spawn(path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script],
    { cwd, env: wrapperEnvironment(temp), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  probe.stdin.end(); probe.stdout.resume(); probe.stderr.resume();
  const done = new Promise<void>((resolve, reject) => { let failed = false; probe.once('error', () => { failed = true; });
    probe.once('close', code => code === 0 && !failed ? resolve() : reject(new Error('PARSER_PLATFORM_TREE_TERMINATION_UNCONFIRMED'))); });
  const timer = setTimeout(() => probe.kill('SIGKILL'), 15000);
  try { await done; } finally { clearTimeout(timer); }
}
/** Verify the entire little compiler tree before deleting; it never follows a junction or an unknown external path. */
function removeCompileTree(target: string, owner: string): void {
  if (path.dirname(target) !== owner || !path.basename(target).startsWith('_platform-') || !fs.existsSync(target)) return;
  let files = 0, total = 0;
  function inspect(file: string) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || fs.realpathSync.native(file) !== file) fail('PARSER_PLATFORM_CLEANUP_UNCONFIRMED');
    if (++files > 256) fail('PARSER_PLATFORM_CLEANUP_UNCONFIRMED');
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) inspect(path.join(file, name));
    else if (stat.isFile() && stat.nlink === 1) { total += stat.size; if (total > 16777216) fail('PARSER_PLATFORM_CLEANUP_UNCONFIRMED'); }
    else fail('PARSER_PLATFORM_CLEANUP_UNCONFIRMED');
  }
  inspect(target); fs.rmSync(target, { recursive: true });
}
async function runHelper(mode: string, values: Record<string, string>, cwd: string, temp = cwd, signal?: AbortSignal,
  tracking?: { identityFile: string; onSpawn(pid: number | undefined, before: number, after: number): void }): Promise<Record<string, unknown>> {
  checkAbort(signal);
  const command = windowsCommand(mode, values, tracking?.identityFile), bornBefore = Date.now(), child = spawn(command.executable, command.args, { cwd, env: wrapperEnvironment(temp), windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'] });
  const bornAfter = Date.now(); child.stdin.end(); let output = '', errorBytes = 0, processFailed = false, aborted = false, stopping: Promise<void> | undefined;
  const stop = () => stopping ??= stopWindowsTree(child, command.executable, bornBefore, bornAfter, cwd, temp);
  const requestStop = () => { void stop().catch(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }); };
  const abort = () => { aborted = true; requestStop(); };
  const done = new Promise<Record<string, unknown>>((resolve, reject) => {
    child.stdout.on('data', bytes => { output += bytes.toString('utf8'); if (Buffer.byteLength(output) > 16384) requestStop(); });
    child.stderr.on('data', bytes => { errorBytes += bytes.length; if (errorBytes > 16384) requestStop(); });
    child.once('error', () => { processFailed = true; });
    child.once('close', code => {
      // Completion is tied to close, including abort and spawn failure. Never abandon a live helper in Promise.race.
      if (aborted || signal?.aborted) return reject(new Error('PARSER_PLATFORM_ABORTED'));
      if (processFailed || code !== 0 || Buffer.byteLength(output) > 16384) return reject(new Error('PARSER_PLATFORM_HELPER_FAILED'));
      try { const value: unknown = JSON.parse(output); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); resolve(value as Record<string, unknown>); }
      catch { reject(new Error('PARSER_PLATFORM_HELPER_FAILED')); }
    });
  });
  try { tracking?.onSpawn(child.pid, bornBefore, bornAfter); }
  catch (error) { requestStop(); try { await done; } catch { } if (stopping) await stopping; throw error; }
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(requestStop, 20000);
  try { return await done; } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (stopping) await stopping; }
}
/** Creates one new directory only. Never changes an existing user's directory, inheritance or integrity label. */
export async function secureParserDirectory(value: string, options: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
  checkAbort(options.signal);
  const target = absolute(value), parent = directory(path.dirname(target));
  if (fs.existsSync(target)) return fail('PARSER_PRIVATE_DIRECTORY_EXISTS');
  if (process.platform !== 'win32') { fs.mkdirSync(target, { mode: 0o700 }); const stat = fs.statSync(target);
    if ((stat.mode & 0o777) !== 0o700) fail('PARSER_PRIVATE_DIRECTORY_FAILED');
    return { platform: process.platform, mechanism: 'posix-mode-fallback', mode: '0700', windowsDacl: 'NOT_APPLICABLE' }; }
  const compile = path.join(parent, '_platform-acl-' + randomUUID()); fs.mkdirSync(compile, { mode: 0o700 });
  const staged = path.join(compile, '_platform-private'), compiler = path.join(compile, '_platform-compile'), ownerFile = path.join(compile, '_platform-owner.json');
  const owner = { schema: 'zhijing-parser-platform-staging-v1', token: path.basename(compile).slice('_platform-acl-'.length), root: parent,
    ownerPid: process.pid, createdUtcMs: Date.now(), helperPid: null as number | null, helperBornBefore: null as number | null, helperBornAfter: null as number | null };
  fs.writeFileSync(ownerFile, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); fs.mkdirSync(compiler, { mode: 0o700 });
  let moved = false, identity: fs.Stats | undefined;
  try {
    // Until validation succeeds, the only new directory is inside our exclusively created UUID container.
    // Killing a helper between CreateDirectoryW and its final receipt therefore cannot leave an unowned target.
    const result = await runHelper('directory', { Directory: staged }, parent, compiler, options.signal, {
      identityFile: path.join(compile, '_platform-helper.json'), onSpawn(pid, before, after) {
        owner.helperPid = pid ?? null; owner.helperBornBefore = before; owner.helperBornAfter = after;
        fs.writeFileSync(ownerFile + '.next', JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); fs.renameSync(ownerFile + '.next', ownerFile);
      }
    }); checkAbort(options.signal);
    const current = result.currentSidProbe as { granted?: number; error?: number } | undefined;
    const outside = result.outsideSidProbe as { granted?: number; error?: number } | undefined;
    if (result.inheritanceProtected !== true || result.allowEntries !== 2 || current?.granted !== 3 || current.error !== 0
      || outside?.granted !== 0 || outside.error !== 5) fail('PARSER_PRIVATE_DIRECTORY_FAILED');
    directory(staged); if (fs.existsSync(target)) fail('PARSER_PRIVATE_DIRECTORY_EXISTS');
    fs.renameSync(staged, target); moved = true; identity = fs.lstatSync(target);
    removeCompileTree(compile, parent); checkAbort(options.signal); return result;
  } catch (error) {
    if (moved && identity && fs.existsSync(target)) {
      const current = fs.lstatSync(target);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || fs.realpathSync.native(target) !== target)
        fail('PARSER_PLATFORM_CLEANUP_UNCONFIRMED');
      // Remove only our exact empty directory. Any unknown newly added file causes a safe failure.
      fs.rmdirSync(target);
    }
    throw error;
  } finally { removeCompileTree(compile, parent); }
}
function processAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; return false; }
}
function smallJson(file: string): Record<string, unknown> {
  regular(file); const stat = fs.lstatSync(file); if (stat.nlink !== 1 || stat.size > 4096) fail('PARSER_PLATFORM_OWNER_INVALID');
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PARSER_PLATFORM_OWNER_INVALID');
  return value as Record<string, unknown>;
}
function validateStagingInventory(container: string, allowed: Set<string>): void {
  for (const entry of fs.readdirSync(container)) if (!allowed.has(entry)) fail('PARSER_PLATFORM_UNKNOWN_STAGING_CONTENT');
  for (const entry of ['_platform-owner.json', '_platform-owner.json.next', '_platform-helper.json', '_platform-helper.json.next']) {
    const file = path.join(container, entry); if (!fs.existsSync(file)) continue;
    const value = smallJson(file);
    if (entry.startsWith('_platform-owner.')) {
      const keys = ['schema', 'token', 'root', 'ownerPid', 'createdUtcMs', 'helperPid', 'helperBornBefore', 'helperBornAfter'];
      if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) || value.schema !== 'zhijing-parser-platform-staging-v1'
        || value.token !== path.basename(container).slice('_platform-acl-'.length) || value.root !== path.dirname(container)
        || !Number.isSafeInteger(value.ownerPid) || Number(value.ownerPid) <= 0 || !Number.isSafeInteger(value.createdUtcMs)
        || ['helperPid', 'helperBornBefore', 'helperBornAfter'].some(key => value[key] !== null && (!Number.isSafeInteger(value[key]) || Number(value[key]) <= 0))) fail('PARSER_PLATFORM_OWNER_INVALID');
    } else if (Object.keys(value).length !== 3 || Object.keys(value).some(key => !['schema', 'pid', 'createdUtcMs'].includes(key))
      || value.schema !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || !Number.isSafeInteger(value.createdUtcMs) || Number(value.createdUtcMs) <= 0) fail('PARSER_PLATFORM_OWNER_INVALID');
  }
  const privateDirectory = path.join(container, '_platform-private'), compiler = path.join(container, '_platform-compile');
  if (fs.existsSync(privateDirectory) && (directory(privateDirectory) !== privateDirectory || fs.readdirSync(privateDirectory).length !== 0)) fail('PARSER_PLATFORM_UNKNOWN_STAGING_CONTENT');
  if (fs.existsSync(compiler)) { directory(compiler); for (const entry of fs.readdirSync(compiler)) {
    const file = path.join(compiler, entry);
    if (entry === 'AppData') {
      directory(file); if (fs.readdirSync(file).some(name => name !== 'Roaming')) fail('PARSER_PLATFORM_UNKNOWN_STAGING_CONTENT');
      const roaming = path.join(file, 'Roaming'); if (fs.existsSync(roaming)) { directory(roaming); if (fs.readdirSync(roaming).length !== 0) fail('PARSER_PLATFORM_UNKNOWN_STAGING_CONTENT'); }
    } else {
      regular(file); if (!/^[a-z0-9]{8}(?:\.0)?\.(?:cs|cmdline|tmp|dll|pdb|out|err|rsp)$/iu.test(entry) || fs.lstatSync(file).nlink !== 1) fail('PARSER_PLATFORM_UNKNOWN_STAGING_CONTENT');
    }
  } }
}
async function recoverStagingCompilers(container: string, helperPid: number, helperCreated: number, root: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const system = process.env.SystemRoot ?? 'C:\\Windows', compiler = directory(path.join(container, '_platform-compile'));
  const expectedPaths = ['Framework', 'Framework64'].map(architecture => path.join(system, 'Microsoft.NET', architecture, 'v4.0.30319/csc.exe'));
  const commandPattern = '^"?(' + expectedPaths.map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')
    + ')"? /noconfig /fullpaths @"(' + compiler.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '\\\\[a-zA-Z0-9_.-]+\\.cmdline)"$';
  const command = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$result=@();$epoch=[DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc);foreach($row in @(Get-CimInstance Win32_Process -Filter 'ParentProcessId="
    + helperPid + "'|Where-Object Name -eq 'csc.exe')){$matched=[regex]::Match($row.CommandLine," + psLiteral(commandPattern) + ",[Text.RegularExpressions.RegexOptions]::IgnoreCase);"
    + "if(-not $matched.Success){throw 'COMPILER_OWNERSHIP_UNCONFIRMED'};$created=[long](($row.CreationDate.ToUniversalTime()-$epoch).TotalMilliseconds);if($created-lt "
    + (helperCreated - 2) + "){throw 'COMPILER_CREATION_UNCONFIRMED'};$result+=@{pid=$row.ProcessId;createdUtcMs=$created;executable=$row.ExecutablePath;responseFile=$matched.Groups[2].Value}};"
    + '[Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress))';
  const probe = spawn(path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command],
    { cwd: root, env: wrapperEnvironment(compiler), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  probe.stdin.end(); let output = '', failed = false; probe.stderr.resume();
  probe.stdout.on('data', bytes => { output += bytes.toString('utf8'); if (Buffer.byteLength(output) > 16384) probe.kill('SIGKILL'); });
  const done = new Promise<void>((resolve, reject) => { probe.once('error', () => { failed = true; }); probe.once('close', code => code === 0 && !failed && Buffer.byteLength(output) <= 16384
    ? resolve() : reject(new Error('PARSER_PLATFORM_COMPILER_RECOVERY_UNCONFIRMED'))); });
  const timer = setTimeout(() => probe.kill('SIGKILL'), 10000); try { await done; } finally { clearTimeout(timer); }
  const identities: unknown = JSON.parse(output); if (!Array.isArray(identities) || identities.length > 4) fail('PARSER_PLATFORM_COMPILER_RECOVERY_UNCONFIRMED');
  for (const value of identities) {
    if (!value || typeof value !== 'object') fail('PARSER_PLATFORM_COMPILER_RECOVERY_UNCONFIRMED');
    const identity = value as Record<string, unknown>;
    if (!Number.isSafeInteger(identity.pid) || Number(identity.pid) <= 0 || !Number.isSafeInteger(identity.createdUtcMs) || typeof identity.executable !== 'string'
      || !expectedPaths.some(file => file.toLowerCase() === String(identity.executable).toLowerCase()) || typeof identity.responseFile !== 'string') fail('PARSER_PLATFORM_COMPILER_RECOVERY_UNCONFIRMED');
    const responseFile = regular(identity.responseFile); if (path.dirname(responseFile) !== compiler || fs.lstatSync(responseFile).nlink !== 1 || fs.statSync(responseFile).size > 32768) fail('PARSER_PLATFORM_COMPILER_RECOVERY_UNCONFIRMED');
    const response = fs.readFileSync(responseFile, 'utf8').toLowerCase(), base = path.basename(responseFile, '.cmdline');
    const source = path.join(compiler, base + '.0.cs'), outputFile = path.join(compiler, base + '.dll'); regular(source);
    if (!response.includes(source.toLowerCase()) || !response.includes(outputFile.toLowerCase())) fail('PARSER_PLATFORM_COMPILER_RECOVERY_UNCONFIRMED');
    await stopWindowsIdentity(Number(identity.pid), identity.executable, Number(identity.createdUtcMs), Number(identity.createdUtcMs), root, compiler);
    if (!processAbsent(Number(identity.pid))) fail('PARSER_PLATFORM_COMPILER_RECOVERY_UNCONFIRMED');
  }
}
/** Recover only strictly identified platform containers. Unknown data, live owners and ambiguous launch identities stay pending. */
export async function recoverParserStaging(value: string): Promise<{ removed: string[]; pending: string[] }> {
  const root = directory(value), removed: string[] = [], pending: string[] = [];
  for (const name of fs.readdirSync(root).filter(name => name.startsWith('_platform-acl-'))) {
    const container = path.join(root, name);
    try {
      directory(container); const token = name.slice('_platform-acl-'.length);
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token)) fail('PARSER_PLATFORM_OWNER_INVALID');
      const owner = smallJson(path.join(container, '_platform-owner.json'));
      if (owner.schema !== 'zhijing-parser-platform-staging-v1' || owner.token !== token || owner.root !== root || !Number.isSafeInteger(owner.ownerPid)
        || Number(owner.ownerPid) <= 0 || !Number.isSafeInteger(owner.createdUtcMs) || !processAbsent(Number(owner.ownerPid))) fail('PARSER_PLATFORM_OWNER_INVALID');
      const allowed = new Set(['_platform-owner.json', '_platform-owner.json.next', '_platform-helper.json', '_platform-helper.json.next', '_platform-private', '_platform-compile']);
      validateStagingInventory(container, allowed); const compiler = path.join(container, '_platform-compile');
      const identityFile = path.join(container, '_platform-helper.json');
      let helperPid: number, helperCreated: number;
      if (fs.existsSync(identityFile)) {
        const identity = smallJson(identityFile);
        if (identity.schema !== 1 || !Number.isSafeInteger(identity.pid) || Number(identity.pid) <= 0 || !Number.isSafeInteger(identity.createdUtcMs)
          || (owner.helperPid !== null && owner.helperPid !== identity.pid)) fail('PARSER_PLATFORM_OWNER_INVALID');
        if (!processAbsent(Number(identity.pid))) {
          if (process.platform !== 'win32') fail('PARSER_PLATFORM_OWNER_INVALID');
          const command = windowsCommand('directory', {});
          await stopWindowsIdentity(Number(identity.pid), command.executable, Number(identity.createdUtcMs), Number(identity.createdUtcMs), root, compiler);
          if (!processAbsent(Number(identity.pid))) fail('PARSER_PLATFORM_TERMINATION_UNCONFIRMED');
        }
        helperPid = Number(identity.pid); helperCreated = Number(identity.createdUtcMs);
      } else if (Number.isSafeInteger(owner.helperPid) && Number(owner.helperPid) > 0) {
        if (!processAbsent(Number(owner.helperPid))) fail('PARSER_PLATFORM_HELPER_IDENTITY_PENDING');
        helperPid = Number(owner.helperPid); helperCreated = Number(owner.helperBornBefore);
      } else fail('PARSER_PLATFORM_HELPER_IDENTITY_PENDING');
      await recoverStagingCompilers(container, helperPid, helperCreated, root);
      // Revalidate the fixed inventory after all known helper processes are confirmed absent.
      validateStagingInventory(container, allowed);
      removeCompileTree(container, root); removed.push(name);
    } catch { pending.push(name); }
  }
  return { removed, pending };
}
function childEnvironment(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'NODE_NO_WARNINGS']) {
    const value = env[key]; if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) fail('PARSER_PLATFORM_ENV_INVALID');
    result[key] = value;
  }
  for (const key of ['TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) result[key] = cwd;
  return result;
}
function receipt(file: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(file)) return;
  regular(file); if (fs.statSync(file).size > 16384) return fail('PARSER_PLATFORM_RECEIPT_INVALID');
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('PARSER_PLATFORM_RECEIPT_INVALID');
  return value as Record<string, unknown>;
}
function closed(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => { child.once('close', () => resolve()); child.once('error', () => reject(new Error('PARSER_PLATFORM_PROCESS_FAILED'))); });
}
/** Flags only in args; entryPoint is appended exactly once, outside any shell. Windows process is the pipe-owning wrapper. */
export async function spawnParserProcess(options: ParserProcessOptions): Promise<ParserPlatformProcess> {
  checkAbort(options.signal);
  const cwd = directory(options.cwd), executable = regular(options.nodeExecutable), entryPoint = regular(options.entryPoint);
  if (!Array.isArray(options.args) || options.args.length > 48 || options.args.some(value => typeof value !== 'string' || !value.startsWith('--') || value.length > 16384 || /[\u0000\r\n]/u.test(value))) fail('PARSER_PLATFORM_ARGS_INVALID');
  const memory = options.jobMemoryMb ?? 512;
  if (!Number.isSafeInteger(memory) || memory < 64 || memory > 1024) fail('PARSER_PLATFORM_MEMORY_INVALID');
  const env = childEnvironment(options.env, cwd);
  if (process.platform !== 'win32') {
    const child = spawn(executable, [...options.args, entryPoint], { cwd, env, windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = closed(child); let stopping: Promise<void> | undefined;
    const terminate = () => stopping ??= (async () => { if (child.exitCode === null && child.signalCode === null && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    } await exit; })();
    const abort = () => { void terminate().catch(() => {}); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { await terminate(); options.signal.removeEventListener('abort', abort); checkAbort(options.signal); }
    return { process: child, metadata: { platform: process.platform, mechanism: 'posix-process-group-fallback', wrapperPid: child.pid, childPid: child.pid,
      systemMemoryLimit: 'NOT_IMPLEMENTED', activeProcessLimit: 'NOT_IMPLEMENTED' },
      terminate, async cleanup() { try { await terminate(); } finally { options.signal?.removeEventListener('abort', abort); } } };
  }
  const configuration = path.join(cwd, configName), receiptFile = path.join(cwd, receiptName), compile = path.join(cwd, compileName);
  if ([configuration, receiptFile, receiptFile + '.next', compile].some(file => fs.existsSync(file))) fail('PARSER_PLATFORM_CONTROL_EXISTS');
  fs.mkdirSync(compile, { mode: 0o700 });
  const data = { nodeExecutable: executable, arguments: [...options.args, entryPoint], cwd, env, jobMemoryMb: memory,
    parentPid: process.pid, parentStartedUtcMs: Math.floor(Date.now() - process.uptime() * 1000), receipt: receiptFile };
  const serialized = JSON.stringify(data); if (Buffer.byteLength(serialized) > 65536) fail('PARSER_PLATFORM_CONFIG_TOO_LARGE');
  fs.writeFileSync(configuration, serialized, { flag: 'wx', mode: 0o600 });
  const command = windowsCommand('job', { ConfigPath: configuration });
  const bornBefore = Date.now(), child = spawn(command.executable, command.args, { cwd, env: wrapperEnvironment(compile), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), bornAfter = Date.now();
  const exit = closed(child); void exit.catch(() => {});
  const metadata: Record<string, unknown> = { platform: 'win32', mechanism: 'Win32-Job-Object', wrapperPid: child.pid, receiptFile,
    applicationLevelBoundary: 'Private directory and Win32 job resource/lifecycle limits; no complete OS filesystem or network sandbox is claimed.' };
  let stopping: Promise<void> | undefined;
  const abort = () => { void terminate().catch(() => {}); };
  options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  async function terminate() {
    return stopping ??= (async () => {
      await stopWindowsTree(child, command.executable, bornBefore, bornAfter, cwd, compile); await exit;
      const value = receipt(receiptFile); if (value) Object.assign(metadata, value);
      if (typeof value?.childPid === 'number' && value.childPid > 0) {
        const confirmation = await runHelper('wait-gone', { ReceiptPath: receiptFile }, cwd, compile);
        if (confirmation.absent !== true) fail('PARSER_PLATFORM_TERMINATION_UNCONFIRMED'); metadata.terminationConfirmation = confirmation;
      }
    })();
  }
  async function cleanup() {
    try {
      await terminate();
      for (const file of [configuration, receiptFile, receiptFile + '.next']) if (fs.existsSync(file)) { regular(file); if (path.dirname(file) !== cwd) fail(); fs.unlinkSync(file); }
      removeCompileTree(compile, cwd);
    } finally { options.signal?.removeEventListener('abort', abort); }
  }
  try {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      checkAbort(options.signal);
      const value = receipt(receiptFile);
      if (value) {
        Object.assign(metadata, value);
        if (!['running', 'exited', 'parent-exited'].includes(String(value.status)) || value.jobAssignedBeforeResume !== true
          || value.wrapperPid !== child.pid || value.activeProcessLimit !== 1 || value.killOnJobClose !== true) fail('PARSER_PLATFORM_START_FAILED');
        checkAbort(options.signal); return { process: child, terminate, cleanup, metadata };
      }
      if (child.exitCode !== null || child.signalCode !== null) fail('PARSER_PLATFORM_START_FAILED');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    fail('PARSER_PLATFORM_START_TIMEOUT');
  } catch (error) { await cleanup(); throw error; }
}
