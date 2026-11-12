// src/materials/vendor/parser/supervisor/index.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { existsSync as existsSync2, lstatSync, realpathSync as realpathSync2 } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname as dirname2, isAbsolute, join as join2, relative, resolve, sep as sep2 } from "node:path";

// src/materials/vendor/domain/document-limits.ts
var MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
var MAX_PDF_PAGES = 50;
var DOCX_MAX_UNCOMPRESSED_SIZE_BYTES = 50 * 1024 * 1024;
var DOCX_MAX_ENTRY_SIZE_BYTES = 20 * 1024 * 1024;
var DOCUMENT_MAX_TEXT_LENGTH = 2e5;
var DOCUMENT_MAX_BLOCKS = 2e4;
var DOCUMENT_PARSER_VERSION = "native-v1-g11.1";

// src/materials/vendor/parser/supervisor/environment.ts
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, parse, sep } from "node:path";
function parserEnvironment(directory2) {
  return {
    ...process.platform === "win32" ? { SystemRoot: process.env.SystemRoot || "C:\\Windows", WINDIR: process.env.WINDIR || "C:\\Windows" } : {},
    ...process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
    TEMP: directory2,
    TMP: directory2,
    TMPDIR: directory2,
    HOME: directory2,
    USERPROFILE: directory2,
    APPDATA: directory2,
    LOCALAPPDATA: directory2,
    LANG: "C.UTF-8",
    TZ: "UTC",
    NO_COLOR: "1"
  };
}
function parserNodeArguments(entry, directory2, heapMb) {
  let packageRoot = dirname(entry), found = false;
  const metadata = [];
  for (; ; ) {
    const manifest = join(packageRoot, "package.json");
    if (existsSync(manifest)) {
      metadata.push(manifest);
      try {
        if (JSON.parse(readFileSync(manifest, "utf8")).name === "dsh-interview-desk") {
          found = true;
          break;
        }
      } catch {
      }
    }
    if (packageRoot === parse(packageRoot).root) break;
    packageRoot = dirname(packageRoot);
  }
  if (!found || !entry.endsWith(".mjs")) throw new Error("PARSER_INVALID_CONFIG");
  for (let parent = dirname(packageRoot); ; parent = dirname(parent)) {
    const manifest = join(parent, "package.json");
    if (existsSync(manifest)) metadata.push(manifest);
    if (parent === dirname(parent)) break;
  }
  const roots = [directory2, dirname(entry), ...metadata];
  const require2 = createRequire(join(packageRoot, "package.json"));
  for (const dependency of ["pdfjs-dist/legacy/build/pdf.mjs", "saxes", "yauzl"]) {
    const file = realpathSync(require2.resolve(dependency));
    const parts = file.split(sep), index = parts.indexOf("node_modules");
    if (index < 0) throw new Error("PARSER_INVALID_CONFIG");
    roots.push(parts.slice(0, index + 1).join(sep));
  }
  const modules = join(packageRoot, "node_modules");
  if (existsSync(modules)) roots.push(modules, realpathSync(modules));
  const args = [`--max-old-space-size=${heapMb}`, "--permission", "--allow-addons", "--disable-proto=throw"];
  for (const path3 of [...new Set(roots)].filter(existsSync)) args.push(`--allow-fs-read=${path3}`);
  return args;
}

// src/materials/vendor/parser/supervisor/limits.ts
var DEFAULT_SUPERVISOR_LIMITS = Object.freeze({
  timeoutMs: 3e4,
  heapMb: 256,
  jobMemoryMb: 512,
  stdoutMaxBytes: 4 * 1024 * 1024,
  concurrency: 2,
  queueLimit: 32
});
var bounds = {
  timeoutMs: [50, 12e4],
  heapMb: [16, 512],
  jobMemoryMb: [64, 1024],
  stdoutMaxBytes: [1024, 8 * 1024 * 1024],
  concurrency: [1, 4],
  queueLimit: [0, 32]
};
function resolveSupervisorLimits(input = {}) {
  if (!input || typeof input !== "object" || Object.keys(input).some((key) => !(key in bounds))) throw new Error("PARSER_INVALID_CONFIG");
  const result = { ...DEFAULT_SUPERVISOR_LIMITS, ...input };
  for (const key of Object.keys(bounds)) {
    const value = result[key], [min, max] = bounds[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("PARSER_INVALID_CONFIG");
  }
  if (result.jobMemoryMb < result.heapMb) throw new Error("PARSER_INVALID_CONFIG");
  return Object.freeze(result);
}

// src/materials/vendor/parser/supervisor/protocol.ts
import { Value as Value2 } from "@sinclair/typebox/value";

// src/materials/vendor/contracts/documents.ts
import { Type } from "@sinclair/typebox";
var Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
var DocumentKindSchema = Type.Union([Type.Literal("pdf"), Type.Literal("docx")]);
var PdfBoundingBoxSchema = Type.Object(
  {
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Number({ minimum: 0 }),
    height: Type.Number({ minimum: 0 })
  },
  { additionalProperties: false }
);
var PdfDocumentBlockSchema = Type.Object(
  {
    kind: Type.Literal("pdf"),
    pageNumber: Type.Integer({ minimum: 1, maximum: MAX_PDF_PAGES }),
    blockIndex: Type.Integer({ minimum: 0 }),
    startOffset: Type.Integer({ minimum: 0 }),
    endOffset: Type.Integer({ minimum: 1 }),
    text: Type.String({ minLength: 1, maxLength: DOCUMENT_MAX_TEXT_LENGTH }),
    bbox: Type.Optional(PdfBoundingBoxSchema)
  },
  { additionalProperties: false }
);
var DocxBlockTypeSchema = Type.Union([
  Type.Literal("paragraph"),
  Type.Literal("listItem"),
  Type.Literal("tableCell")
]);
var DocxDocumentBlockSchema = Type.Object(
  {
    kind: Type.Literal("docx"),
    blockIndex: Type.Integer({ minimum: 0 }),
    blockType: DocxBlockTypeSchema,
    path: Type.String({ minLength: 1, maxLength: 500 }),
    sourcePart: Type.Optional(Type.String({ maxLength: 64, pattern: "^word/(?:document|(?:header|footer)(?:[1-9]|[12][0-9]|3[0-2]))\\.xml$" })),
    startOffset: Type.Integer({ minimum: 0 }),
    endOffset: Type.Integer({ minimum: 1 }),
    text: Type.String({ minLength: 1, maxLength: DOCUMENT_MAX_TEXT_LENGTH })
  },
  { additionalProperties: false }
);
var DocumentBlockSchema = Type.Union([PdfDocumentBlockSchema, DocxDocumentBlockSchema]);
var DocumentParseResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal("document-parse/v1"),
    documentKind: DocumentKindSchema,
    plainText: Type.String({ minLength: 1, maxLength: DOCUMENT_MAX_TEXT_LENGTH }),
    contentHash: Sha256Schema,
    blocks: Type.Array(DocumentBlockSchema, { minItems: 1, maxItems: DOCUMENT_MAX_BLOCKS }),
    pageCount: Type.Union([Type.Integer({ minimum: 1, maximum: MAX_PDF_PAGES }), Type.Null()]),
    parserName: Type.String({ minLength: 1, maxLength: 100 }),
    parserVersion: Type.String({ minLength: 1, maxLength: 100 }),
    qualityScore: Type.Number({ minimum: 0, maximum: 1 }),
    qualityReasons: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: 100
    }),
    requiresConfirmation: Type.Optional(Type.Boolean())
  },
  { additionalProperties: false }
);
var DOCUMENT_FAILURE_CODES = ["FILE_TYPE_MISMATCH", "DOCUMENT_READ_FAILED", "DOCUMENT_TOO_LARGE", "DOCUMENT_UNSAFE", "PDF_TOO_MANY_PAGES", "DOCX_ARCHIVE_LIMIT", "DOCUMENT_TEXT_EMPTY", "DOCUMENT_RESULT_INVALID"];
var DocumentParseOutcomeSchema = Type.Union([
  Type.Object({ status: Type.Literal("PARSED"), result: DocumentParseResultSchema }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal("OCR_REQUIRED"), reason: Type.Union([Type.Literal("image"), Type.Literal("insufficient-text")]) }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal("FAILED"), code: Type.Union(DOCUMENT_FAILURE_CODES.map((code) => Type.Literal(code))) }, { additionalProperties: false })
]);

// src/materials/vendor/parser/validate-result.ts
import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
function invalid() {
  throw new Error("DOCUMENT_RESULT_INVALID");
}
function wellFormed(text) {
  for (const character of text) {
    const point = character.codePointAt(0);
    if (point >= 55296 && point <= 57343) return false;
  }
  return true;
}
function boundary(text, position) {
  const previous = text.charCodeAt(position - 1), next = text.charCodeAt(position);
  return !(previous >= 55296 && previous <= 56319 && next >= 56320 && next <= 57343);
}
function validateDocumentParseResult(value) {
  if (!Value.Check(DocumentParseResultSchema, value)) invalid();
  const result = value, text = result.plainText;
  if (!wellFormed(text) || text.includes("\r") || text.length > DOCUMENT_MAX_TEXT_LENGTH) invalid();
  if (createHash("sha256").update(text, "utf8").digest("hex") !== result.contentHash) invalid();
  const reviewRequired = result.qualityReasons.some((reason) => reason === "reading-order-review-required" || reason === "unsupported-structure-review-required");
  if (reviewRequired && result.requiresConfirmation !== true || result.requiresConfirmation === true && result.qualityScore > 0.8) invalid();
  if (result.documentKind === "docx" ? result.pageCount !== null : !Number.isSafeInteger(result.pageCount)) invalid();
  let previousEnd = 0, previousPage = 0;
  for (const [index, block2] of result.blocks.entries()) {
    if (block2.kind !== result.documentKind || block2.blockIndex !== index || !Number.isSafeInteger(block2.blockIndex)) invalid();
    const { startOffset: start, endOffset: end } = block2;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length || start !== (index === 0 ? 0 : previousEnd + 1) || !boundary(text, start) || !boundary(text, end) || !wellFormed(block2.text) || text.slice(start, end) !== block2.text) invalid();
    if (block2.kind === "pdf") {
      if (!Number.isSafeInteger(block2.pageNumber) || block2.pageNumber < 1 || block2.pageNumber > result.pageCount || block2.pageNumber < previousPage) invalid();
      previousPage = block2.pageNumber;
      if (block2.bbox && (!Object.values(block2.bbox).every(Number.isFinite) || block2.bbox.width < 0 || block2.bbox.height < 0)) invalid();
    } else {
      const location = /^(document|word\/(?:header|footer)[1-9]\d*\.xml)\/((?:table\[[1-9]\d*\]\/row\[[1-9]\d*\]\/cell\[[1-9]\d*\]\/){0,8}paragraph\[[1-9]\d*\])$/u.exec(block2.path);
      if (!location || (location[1] === "document" ? block2.sourcePart !== void 0 && block2.sourcePart !== "word/document.xml" : block2.sourcePart !== location[1])) invalid();
    }
    previousEnd = end;
  }
  if (previousEnd !== text.length || result.blocks.map((block2) => block2.text).join("\n") !== text) invalid();
}
function freezeDocumentResult(result) {
  validateDocumentParseResult(result);
  for (const block2 of result.blocks) {
    if (block2.kind === "pdf" && block2.bbox) Object.freeze(block2.bbox);
    Object.freeze(block2);
  }
  Object.freeze(result.blocks);
  Object.freeze(result.qualityReasons);
  return Object.freeze(result);
}

// src/materials/vendor/parser/supervisor/protocol.ts
var CHILD_SCHEMA_VERSION = "document-child/v1";
var CHILD_REQUEST_MAX_BYTES = 8192;
var CHILD_OUTPUT_CEILING_BYTES = 8 * 1024 * 1024;
var TASK_ID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu;
function exactKeys(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function isTaskIdentity(taskId, generation) {
  return typeof taskId === "string" && TASK_ID_PATTERN.test(taskId) && typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0;
}
function decodeChildReply(bytes, request) {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!exactKeys(value, ["schemaVersion", "taskId", "generation", "outcome"]) || value.schemaVersion !== CHILD_SCHEMA_VERSION || value.taskId !== request.taskId || value.generation !== request.generation || !Value2.Check(DocumentParseOutcomeSchema, value.outcome)) {
    throw new Error("PARSER_INVALID_REPLY");
  }
  const outcome = value.outcome;
  if (outcome.status === "PARSED") {
    if (outcome.result.parserVersion !== request.parserVersion || outcome.result.documentKind !== request.documentKind) throw new Error("PARSER_INVALID_REPLY");
    freezeDocumentResult(outcome.result);
  } else if (outcome.status === "OCR_REQUIRED" && outcome.reason === "image" !== (request.documentKind === "image")) {
    throw new Error("PARSER_INVALID_REPLY");
  }
  return outcome;
}

// src/materials/vendor/parser/supervisor/platform.ts
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
var configName = "_platform-config.json";
var receiptName = "_platform-receipt.json";
var compileName = "_platform-compile";
function fail(code = "PARSER_PLATFORM_FAILED") {
  throw new Error(code);
}
function checkAbort(signal) {
  if (signal?.aborted) fail("PARSER_PLATFORM_ABORTED");
}
function absolute(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\u0000-\u001f]/u.test(value)) fail("PARSER_PLATFORM_PATH_INVALID");
  return path.resolve(value);
}
function directory(value) {
  const full = absolute(value), stat = fs.lstatSync(full);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(full) !== full) fail("PARSER_PLATFORM_PATH_INVALID");
  return full;
}
function regular(value) {
  const full = absolute(value), stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync.native(full) !== full) fail("PARSER_PLATFORM_PATH_INVALID");
  return full;
}
function resourceDirectory() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [here, path.join(here, "supervisor")]) {
    if (fs.existsSync(path.join(candidate, "windows-job.ps1")) && fs.existsSync(path.join(candidate, "windows-job.cs"))) {
      regular(path.join(candidate, "windows-job.ps1"));
      regular(path.join(candidate, "windows-job.cs"));
      return candidate;
    }
  }
  return fail("PARSER_PLATFORM_RESOURCES_MISSING");
}
function psLiteral(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}
function windowsCommand(mode, values, identityFile) {
  const resources = resourceDirectory(), system = process.env.SystemRoot ?? "C:\\Windows";
  const executable = path.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const identity = identityFile ? "$self=[Diagnostics.Process]::GetCurrentProcess();$epoch=[DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc);$identity=@{schema=1;pid=$PID;createdUtcMs=[long](($self.StartTime.ToUniversalTime()-$epoch).TotalMilliseconds)}|ConvertTo-Json -Compress;[IO.File]::WriteAllText(" + psLiteral(identityFile + ".next") + ",$identity);[IO.File]::Move(" + psLiteral(identityFile + ".next") + "," + psLiteral(identityFile) + ");" : "";
  const command = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); " + identity + " & ([ScriptBlock]::Create([IO.File]::ReadAllText(" + psLiteral(path.join(resources, "windows-job.ps1")) + "))) -Mode " + psLiteral(mode) + " -ResourceDirectory " + psLiteral(resources) + Object.entries(values).map(([name, value]) => " -" + name + " " + psLiteral(value)).join("");
  return { executable, args: ["-NoProfile", "-NonInteractive", "-Command", command] };
}
function wrapperEnvironment(temp) {
  const system = process.env.SystemRoot ?? "C:\\Windows";
  return {
    SystemRoot: system,
    WINDIR: system,
    PATH: path.join(system, "System32"),
    TEMP: temp,
    TMP: temp,
    USERPROFILE: temp,
    APPDATA: temp,
    LOCALAPPDATA: temp
  };
}
async function stopWindowsTree(child, executable, bornBefore, bornAfter, cwd, temp) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await stopWindowsIdentity(child.pid, executable, bornBefore, bornAfter, cwd, temp);
}
async function stopWindowsIdentity(pid, executable, bornBefore, bornAfter, cwd, temp) {
  const system = process.env.SystemRoot ?? "C:\\Windows";
  const script = "$ErrorActionPreference='Stop'; try{$owned=[Diagnostics.Process]::GetProcessById(" + pid + ")}catch [ArgumentException]{exit 0};try{$null=$owned.Handle;if($owned.HasExited){exit 0};$epoch=[DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc);$created=[long](($owned.StartTime.ToUniversalTime()-$epoch).TotalMilliseconds);if($created-lt " + (bornBefore - 2) + "-or $created-gt " + (bornAfter + 2) + "){throw 'OWNED_PROCESS_IDENTITY_CHANGED'};try{$actualExecutable=$owned.MainModule.FileName}catch{if($owned.HasExited){exit 0};throw};if($actualExecutable-ne " + psLiteral(executable) + "){throw 'OWNED_PROCESS_EXECUTABLE_CHANGED'};if(-not $owned.HasExited){$killer=New-Object Diagnostics.Process;$killer.StartInfo.FileName=" + psLiteral(path.join(system, "System32/taskkill.exe")) + ";$killer.StartInfo.Arguments='/PID " + pid + " /T /F';$killer.StartInfo.UseShellExecute=$false;$killer.StartInfo.CreateNoWindow=$true;$killer.StartInfo.RedirectStandardOutput=$true;$killer.StartInfo.RedirectStandardError=$true;try{$null=$killer.Start();$null=$killer.StandardOutput.ReadToEnd();$null=$killer.StandardError.ReadToEnd();if(-not $killer.WaitForExit(10000)){$killer.Kill();throw 'OWNED_TREE_TERMINATION_TIMEOUT'};if($killer.ExitCode-ne 0-and -not $owned.HasExited){throw 'OWNED_TREE_TERMINATION_FAILED'}}finally{$killer.Dispose()}};if(-not $owned.WaitForExit(10000)){throw 'OWNED_PROCESS_STILL_RUNNING'}}finally{$owned.Dispose()}";
  const probe = spawn(
    path.join(system, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { cwd, env: wrapperEnvironment(temp), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
  );
  probe.stdin.end();
  probe.stdout.resume();
  probe.stderr.resume();
  const done = new Promise((resolve2, reject2) => {
    let failed = false;
    probe.once("error", () => {
      failed = true;
    });
    probe.once("close", (code) => code === 0 && !failed ? resolve2() : reject2(new Error("PARSER_PLATFORM_TREE_TERMINATION_UNCONFIRMED")));
  });
  const timer = setTimeout(() => probe.kill("SIGKILL"), 15e3);
  try {
    await done;
  } finally {
    clearTimeout(timer);
  }
}
function removeCompileTree(target, owner) {
  if (path.dirname(target) !== owner || !path.basename(target).startsWith("_platform-") || !fs.existsSync(target)) return;
  let files = 0, total = 0;
  function inspect(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || fs.realpathSync.native(file) !== file) fail("PARSER_PLATFORM_CLEANUP_UNCONFIRMED");
    if (++files > 256) fail("PARSER_PLATFORM_CLEANUP_UNCONFIRMED");
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) inspect(path.join(file, name));
    else if (stat.isFile() && stat.nlink === 1) {
      total += stat.size;
      if (total > 16777216) fail("PARSER_PLATFORM_CLEANUP_UNCONFIRMED");
    } else fail("PARSER_PLATFORM_CLEANUP_UNCONFIRMED");
  }
  inspect(target);
  fs.rmSync(target, { recursive: true });
}
async function runHelper(mode, values, cwd, temp = cwd, signal, tracking) {
  checkAbort(signal);
  const command = windowsCommand(mode, values, tracking?.identityFile), bornBefore = Date.now(), child = spawn(command.executable, command.args, {
    cwd,
    env: wrapperEnvironment(temp),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const bornAfter = Date.now();
  child.stdin.end();
  let output = "", errorBytes = 0, processFailed = false, aborted = false, stopping;
  const stop = () => stopping ??= stopWindowsTree(child, command.executable, bornBefore, bornAfter, cwd, temp);
  const requestStop = () => {
    void stop().catch(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
  };
  const abort = () => {
    aborted = true;
    requestStop();
  };
  const done = new Promise((resolve2, reject2) => {
    child.stdout.on("data", (bytes) => {
      output += bytes.toString("utf8");
      if (Buffer.byteLength(output) > 16384) requestStop();
    });
    child.stderr.on("data", (bytes) => {
      errorBytes += bytes.length;
      if (errorBytes > 16384) requestStop();
    });
    child.once("error", () => {
      processFailed = true;
    });
    child.once("close", (code) => {
      if (aborted || signal?.aborted) return reject2(new Error("PARSER_PLATFORM_ABORTED"));
      if (processFailed || code !== 0 || Buffer.byteLength(output) > 16384) return reject2(new Error("PARSER_PLATFORM_HELPER_FAILED"));
      try {
        const value = JSON.parse(output);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        resolve2(value);
      } catch {
        reject2(new Error("PARSER_PLATFORM_HELPER_FAILED"));
      }
    });
  });
  try {
    tracking?.onSpawn(child.pid, bornBefore, bornAfter);
  } catch (error) {
    requestStop();
    try {
      await done;
    } catch {
    }
    if (stopping) await stopping;
    throw error;
  }
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(requestStop, 2e4);
  try {
    return await done;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (stopping) await stopping;
  }
}
async function secureParserDirectory(value, options = {}) {
  checkAbort(options.signal);
  const target = absolute(value), parent = directory(path.dirname(target));
  if (fs.existsSync(target)) return fail("PARSER_PRIVATE_DIRECTORY_EXISTS");
  if (process.platform !== "win32") {
    fs.mkdirSync(target, { mode: 448 });
    const stat = fs.statSync(target);
    if ((stat.mode & 511) !== 448) fail("PARSER_PRIVATE_DIRECTORY_FAILED");
    return { platform: process.platform, mechanism: "posix-mode-fallback", mode: "0700", windowsDacl: "NOT_APPLICABLE" };
  }
  const compile = path.join(parent, "_platform-acl-" + randomUUID());
  fs.mkdirSync(compile, { mode: 448 });
  const staged = path.join(compile, "_platform-private"), compiler = path.join(compile, "_platform-compile"), ownerFile = path.join(compile, "_platform-owner.json");
  const owner = {
    schema: "zhijing-parser-platform-staging-v1",
    token: path.basename(compile).slice("_platform-acl-".length),
    root: parent,
    ownerPid: process.pid,
    createdUtcMs: Date.now(),
    helperPid: null,
    helperBornBefore: null,
    helperBornAfter: null
  };
  fs.writeFileSync(ownerFile, JSON.stringify(owner), { flag: "wx", mode: 384 });
  fs.mkdirSync(compiler, { mode: 448 });
  let moved = false, identity;
  try {
    const result = await runHelper("directory", { Directory: staged }, parent, compiler, options.signal, {
      identityFile: path.join(compile, "_platform-helper.json"),
      onSpawn(pid, before, after) {
        owner.helperPid = pid ?? null;
        owner.helperBornBefore = before;
        owner.helperBornAfter = after;
        fs.writeFileSync(ownerFile + ".next", JSON.stringify(owner), { flag: "wx", mode: 384 });
        fs.renameSync(ownerFile + ".next", ownerFile);
      }
    });
    checkAbort(options.signal);
    const current = result.currentSidProbe;
    const outside = result.outsideSidProbe;
    if (result.inheritanceProtected !== true || result.allowEntries !== 2 || current?.granted !== 3 || current.error !== 0 || outside?.granted !== 0 || outside.error !== 5) fail("PARSER_PRIVATE_DIRECTORY_FAILED");
    directory(staged);
    if (fs.existsSync(target)) fail("PARSER_PRIVATE_DIRECTORY_EXISTS");
    fs.renameSync(staged, target);
    moved = true;
    identity = fs.lstatSync(target);
    removeCompileTree(compile, parent);
    checkAbort(options.signal);
    return result;
  } catch (error) {
    if (moved && identity && fs.existsSync(target)) {
      const current = fs.lstatSync(target);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || fs.realpathSync.native(target) !== target)
        fail("PARSER_PLATFORM_CLEANUP_UNCONFIRMED");
      fs.rmdirSync(target);
    }
    throw error;
  } finally {
    removeCompileTree(compile, parent);
  }
}
function processAbsent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    return false;
  }
}
function smallJson(file) {
  regular(file);
  const stat = fs.lstatSync(file);
  if (stat.nlink !== 1 || stat.size > 4096) fail("PARSER_PLATFORM_OWNER_INVALID");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("PARSER_PLATFORM_OWNER_INVALID");
  return value;
}
function validateStagingInventory(container, allowed) {
  for (const entry of fs.readdirSync(container)) if (!allowed.has(entry)) fail("PARSER_PLATFORM_UNKNOWN_STAGING_CONTENT");
  for (const entry of ["_platform-owner.json", "_platform-owner.json.next", "_platform-helper.json", "_platform-helper.json.next"]) {
    const file = path.join(container, entry);
    if (!fs.existsSync(file)) continue;
    const value = smallJson(file);
    if (entry.startsWith("_platform-owner.")) {
      const keys = ["schema", "token", "root", "ownerPid", "createdUtcMs", "helperPid", "helperBornBefore", "helperBornAfter"];
      if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)) || value.schema !== "zhijing-parser-platform-staging-v1" || value.token !== path.basename(container).slice("_platform-acl-".length) || value.root !== path.dirname(container) || !Number.isSafeInteger(value.ownerPid) || Number(value.ownerPid) <= 0 || !Number.isSafeInteger(value.createdUtcMs) || ["helperPid", "helperBornBefore", "helperBornAfter"].some((key) => value[key] !== null && (!Number.isSafeInteger(value[key]) || Number(value[key]) <= 0))) fail("PARSER_PLATFORM_OWNER_INVALID");
    } else if (Object.keys(value).length !== 3 || Object.keys(value).some((key) => !["schema", "pid", "createdUtcMs"].includes(key)) || value.schema !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || !Number.isSafeInteger(value.createdUtcMs) || Number(value.createdUtcMs) <= 0) fail("PARSER_PLATFORM_OWNER_INVALID");
  }
  const privateDirectory = path.join(container, "_platform-private"), compiler = path.join(container, "_platform-compile");
  if (fs.existsSync(privateDirectory) && (directory(privateDirectory) !== privateDirectory || fs.readdirSync(privateDirectory).length !== 0)) fail("PARSER_PLATFORM_UNKNOWN_STAGING_CONTENT");
  if (fs.existsSync(compiler)) {
    directory(compiler);
    for (const entry of fs.readdirSync(compiler)) {
      const file = path.join(compiler, entry);
      if (entry === "AppData") {
        directory(file);
        if (fs.readdirSync(file).some((name) => name !== "Roaming")) fail("PARSER_PLATFORM_UNKNOWN_STAGING_CONTENT");
        const roaming = path.join(file, "Roaming");
        if (fs.existsSync(roaming)) {
          directory(roaming);
          if (fs.readdirSync(roaming).length !== 0) fail("PARSER_PLATFORM_UNKNOWN_STAGING_CONTENT");
        }
      } else {
        regular(file);
        if (!/^[a-z0-9]{8}(?:\.0)?\.(?:cs|cmdline|tmp|dll|pdb|out|err|rsp)$/iu.test(entry) || fs.lstatSync(file).nlink !== 1) fail("PARSER_PLATFORM_UNKNOWN_STAGING_CONTENT");
      }
    }
  }
}
async function recoverStagingCompilers(container, helperPid, helperCreated, root) {
  if (process.platform !== "win32") return;
  const system = process.env.SystemRoot ?? "C:\\Windows", compiler = directory(path.join(container, "_platform-compile"));
  const expectedPaths = ["Framework", "Framework64"].map((architecture) => path.join(system, "Microsoft.NET", architecture, "v4.0.30319/csc.exe"));
  const commandPattern = '^"?(' + expectedPaths.map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|") + ')"? /noconfig /fullpaths @"(' + compiler.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + '\\\\[a-zA-Z0-9_.-]+\\.cmdline)"$';
  const command = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$result=@();$epoch=[DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc);foreach($row in @(Get-CimInstance Win32_Process -Filter 'ParentProcessId=" + helperPid + "'|Where-Object Name -eq 'csc.exe')){$matched=[regex]::Match($row.CommandLine," + psLiteral(commandPattern) + ",[Text.RegularExpressions.RegexOptions]::IgnoreCase);if(-not $matched.Success){throw 'COMPILER_OWNERSHIP_UNCONFIRMED'};$created=[long](($row.CreationDate.ToUniversalTime()-$epoch).TotalMilliseconds);if($created-lt " + (helperCreated - 2) + "){throw 'COMPILER_CREATION_UNCONFIRMED'};$result+=@{pid=$row.ProcessId;createdUtcMs=$created;executable=$row.ExecutablePath;responseFile=$matched.Groups[2].Value}};[Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress))";
  const probe = spawn(
    path.join(system, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { cwd: root, env: wrapperEnvironment(compiler), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
  );
  probe.stdin.end();
  let output = "", failed = false;
  probe.stderr.resume();
  probe.stdout.on("data", (bytes) => {
    output += bytes.toString("utf8");
    if (Buffer.byteLength(output) > 16384) probe.kill("SIGKILL");
  });
  const done = new Promise((resolve2, reject2) => {
    probe.once("error", () => {
      failed = true;
    });
    probe.once("close", (code) => code === 0 && !failed && Buffer.byteLength(output) <= 16384 ? resolve2() : reject2(new Error("PARSER_PLATFORM_COMPILER_RECOVERY_UNCONFIRMED")));
  });
  const timer = setTimeout(() => probe.kill("SIGKILL"), 1e4);
  try {
    await done;
  } finally {
    clearTimeout(timer);
  }
  const identities = JSON.parse(output);
  if (!Array.isArray(identities) || identities.length > 4) fail("PARSER_PLATFORM_COMPILER_RECOVERY_UNCONFIRMED");
  for (const value of identities) {
    if (!value || typeof value !== "object") fail("PARSER_PLATFORM_COMPILER_RECOVERY_UNCONFIRMED");
    const identity = value;
    if (!Number.isSafeInteger(identity.pid) || Number(identity.pid) <= 0 || !Number.isSafeInteger(identity.createdUtcMs) || typeof identity.executable !== "string" || !expectedPaths.some((file) => file.toLowerCase() === String(identity.executable).toLowerCase()) || typeof identity.responseFile !== "string") fail("PARSER_PLATFORM_COMPILER_RECOVERY_UNCONFIRMED");
    const responseFile = regular(identity.responseFile);
    if (path.dirname(responseFile) !== compiler || fs.lstatSync(responseFile).nlink !== 1 || fs.statSync(responseFile).size > 32768) fail("PARSER_PLATFORM_COMPILER_RECOVERY_UNCONFIRMED");
    const response = fs.readFileSync(responseFile, "utf8").toLowerCase(), base = path.basename(responseFile, ".cmdline");
    const source = path.join(compiler, base + ".0.cs"), outputFile = path.join(compiler, base + ".dll");
    regular(source);
    if (!response.includes(source.toLowerCase()) || !response.includes(outputFile.toLowerCase())) fail("PARSER_PLATFORM_COMPILER_RECOVERY_UNCONFIRMED");
    await stopWindowsIdentity(Number(identity.pid), identity.executable, Number(identity.createdUtcMs), Number(identity.createdUtcMs), root, compiler);
    if (!processAbsent(Number(identity.pid))) fail("PARSER_PLATFORM_COMPILER_RECOVERY_UNCONFIRMED");
  }
}
async function recoverParserStaging(value) {
  const root = directory(value), removed = [], pending = [];
  for (const name of fs.readdirSync(root).filter((name2) => name2.startsWith("_platform-acl-"))) {
    const container = path.join(root, name);
    try {
      directory(container);
      const token = name.slice("_platform-acl-".length);
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token)) fail("PARSER_PLATFORM_OWNER_INVALID");
      const owner = smallJson(path.join(container, "_platform-owner.json"));
      if (owner.schema !== "zhijing-parser-platform-staging-v1" || owner.token !== token || owner.root !== root || !Number.isSafeInteger(owner.ownerPid) || Number(owner.ownerPid) <= 0 || !Number.isSafeInteger(owner.createdUtcMs) || !processAbsent(Number(owner.ownerPid))) fail("PARSER_PLATFORM_OWNER_INVALID");
      const allowed = /* @__PURE__ */ new Set(["_platform-owner.json", "_platform-owner.json.next", "_platform-helper.json", "_platform-helper.json.next", "_platform-private", "_platform-compile"]);
      validateStagingInventory(container, allowed);
      const compiler = path.join(container, "_platform-compile");
      const identityFile = path.join(container, "_platform-helper.json");
      let helperPid, helperCreated;
      if (fs.existsSync(identityFile)) {
        const identity = smallJson(identityFile);
        if (identity.schema !== 1 || !Number.isSafeInteger(identity.pid) || Number(identity.pid) <= 0 || !Number.isSafeInteger(identity.createdUtcMs) || owner.helperPid !== null && owner.helperPid !== identity.pid) fail("PARSER_PLATFORM_OWNER_INVALID");
        if (!processAbsent(Number(identity.pid))) {
          if (process.platform !== "win32") fail("PARSER_PLATFORM_OWNER_INVALID");
          const command = windowsCommand("directory", {});
          await stopWindowsIdentity(Number(identity.pid), command.executable, Number(identity.createdUtcMs), Number(identity.createdUtcMs), root, compiler);
          if (!processAbsent(Number(identity.pid))) fail("PARSER_PLATFORM_TERMINATION_UNCONFIRMED");
        }
        helperPid = Number(identity.pid);
        helperCreated = Number(identity.createdUtcMs);
      } else if (Number.isSafeInteger(owner.helperPid) && Number(owner.helperPid) > 0) {
        if (!processAbsent(Number(owner.helperPid))) fail("PARSER_PLATFORM_HELPER_IDENTITY_PENDING");
        helperPid = Number(owner.helperPid);
        helperCreated = Number(owner.helperBornBefore);
      } else fail("PARSER_PLATFORM_HELPER_IDENTITY_PENDING");
      await recoverStagingCompilers(container, helperPid, helperCreated, root);
      validateStagingInventory(container, allowed);
      removeCompileTree(container, root);
      removed.push(name);
    } catch {
      pending.push(name);
    }
  }
  return { removed, pending };
}
function childEnvironment(env, cwd) {
  const result = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "NODE_NO_WARNINGS"]) {
    const value = env[key];
    if (value === void 0) continue;
    if (typeof value !== "string" || value.length > 8192 || value.includes("\0")) fail("PARSER_PLATFORM_ENV_INVALID");
    result[key] = value;
  }
  for (const key of ["TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"]) result[key] = cwd;
  return result;
}
function receipt(file) {
  if (!fs.existsSync(file)) return;
  regular(file);
  if (fs.statSync(file).size > 16384) return fail("PARSER_PLATFORM_RECEIPT_INVALID");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("PARSER_PLATFORM_RECEIPT_INVALID");
  return value;
}
function closed(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve2, reject2) => {
    child.once("close", () => resolve2());
    child.once("error", () => reject2(new Error("PARSER_PLATFORM_PROCESS_FAILED")));
  });
}
async function spawnParserProcess(options) {
  checkAbort(options.signal);
  const cwd = directory(options.cwd), executable = regular(options.nodeExecutable), entryPoint = regular(options.entryPoint);
  if (!Array.isArray(options.args) || options.args.length > 48 || options.args.some((value) => typeof value !== "string" || !value.startsWith("--") || value.length > 16384 || /[\u0000\r\n]/u.test(value))) fail("PARSER_PLATFORM_ARGS_INVALID");
  const memory = options.jobMemoryMb ?? 512;
  if (!Number.isSafeInteger(memory) || memory < 64 || memory > 1024) fail("PARSER_PLATFORM_MEMORY_INVALID");
  const env = childEnvironment(options.env, cwd);
  if (process.platform !== "win32") {
    const child2 = spawn(executable, [...options.args, entryPoint], { cwd, env, windowsHide: true, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const exit2 = closed(child2);
    let stopping2;
    const terminate2 = () => stopping2 ??= (async () => {
      if (child2.exitCode === null && child2.signalCode === null && child2.pid) {
        try {
          process.kill(-child2.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      await exit2;
    })();
    const abort2 = () => {
      void terminate2().catch(() => {
      });
    };
    options.signal?.addEventListener("abort", abort2, { once: true });
    if (options.signal?.aborted) {
      await terminate2();
      options.signal.removeEventListener("abort", abort2);
      checkAbort(options.signal);
    }
    return {
      process: child2,
      metadata: {
        platform: process.platform,
        mechanism: "posix-process-group-fallback",
        wrapperPid: child2.pid,
        childPid: child2.pid,
        systemMemoryLimit: "NOT_IMPLEMENTED",
        activeProcessLimit: "NOT_IMPLEMENTED"
      },
      terminate: terminate2,
      async cleanup() {
        try {
          await terminate2();
        } finally {
          options.signal?.removeEventListener("abort", abort2);
        }
      }
    };
  }
  const configuration = path.join(cwd, configName), receiptFile = path.join(cwd, receiptName), compile = path.join(cwd, compileName);
  if ([configuration, receiptFile, receiptFile + ".next", compile].some((file) => fs.existsSync(file))) fail("PARSER_PLATFORM_CONTROL_EXISTS");
  fs.mkdirSync(compile, { mode: 448 });
  const data = {
    nodeExecutable: executable,
    arguments: [...options.args, entryPoint],
    cwd,
    env,
    jobMemoryMb: memory,
    parentPid: process.pid,
    parentStartedUtcMs: Math.floor(Date.now() - process.uptime() * 1e3),
    receipt: receiptFile
  };
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized) > 65536) fail("PARSER_PLATFORM_CONFIG_TOO_LARGE");
  fs.writeFileSync(configuration, serialized, { flag: "wx", mode: 384 });
  const command = windowsCommand("job", { ConfigPath: configuration });
  const bornBefore = Date.now(), child = spawn(command.executable, command.args, { cwd, env: wrapperEnvironment(compile), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }), bornAfter = Date.now();
  const exit = closed(child);
  void exit.catch(() => {
  });
  const metadata = {
    platform: "win32",
    mechanism: "Win32-Job-Object",
    wrapperPid: child.pid,
    receiptFile,
    applicationLevelBoundary: "Private directory and Win32 job resource/lifecycle limits; no complete OS filesystem or network sandbox is claimed."
  };
  let stopping;
  const abort = () => {
    void terminate().catch(() => {
    });
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  async function terminate() {
    return stopping ??= (async () => {
      await stopWindowsTree(child, command.executable, bornBefore, bornAfter, cwd, compile);
      await exit;
      const value = receipt(receiptFile);
      if (value) Object.assign(metadata, value);
      if (typeof value?.childPid === "number" && value.childPid > 0) {
        const confirmation = await runHelper("wait-gone", { ReceiptPath: receiptFile }, cwd, compile);
        if (confirmation.absent !== true) fail("PARSER_PLATFORM_TERMINATION_UNCONFIRMED");
        metadata.terminationConfirmation = confirmation;
      }
    })();
  }
  async function cleanup() {
    try {
      await terminate();
      for (const file of [configuration, receiptFile, receiptFile + ".next"]) if (fs.existsSync(file)) {
        regular(file);
        if (path.dirname(file) !== cwd) fail();
        fs.unlinkSync(file);
      }
      removeCompileTree(compile, cwd);
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }
  try {
    const end = Date.now() + 2e4;
    while (Date.now() < end) {
      checkAbort(options.signal);
      const value = receipt(receiptFile);
      if (value) {
        Object.assign(metadata, value);
        if (!["running", "exited", "parent-exited"].includes(String(value.status)) || value.jobAssignedBeforeResume !== true || value.wrapperPid !== child.pid || value.activeProcessLimit !== 1 || value.killOnJobClose !== true) fail("PARSER_PLATFORM_START_FAILED");
        checkAbort(options.signal);
        return { process: child, terminate, cleanup, metadata };
      }
      if (child.exitCode !== null || child.signalCode !== null) fail("PARSER_PLATFORM_START_FAILED");
      await new Promise((resolve2) => setTimeout(resolve2, 15));
    }
    fail("PARSER_PLATFORM_START_TIMEOUT");
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// src/materials/vendor/parser/supervisor/index.ts
var PLATFORM_ENTRIES = /* @__PURE__ */ new Set(["_platform-config.json", "_platform-receipt.json", "_platform-receipt.json.next", "_platform-compile"]);
var ParserSupervisor = class {
  limits;
  options;
  ready;
  jobs = /* @__PURE__ */ new Map();
  queue = [];
  running = 0;
  closed = false;
  constructor(options) {
    if (!options || ![options.root, options.childEntry, options.nodeExecutable].every((value) => typeof value === "string" && isAbsolute(value))) throw new Error("PARSER_INVALID_CONFIG");
    const root = resolve(options.root), entry = realpathSync2(options.childEntry), node = realpathSync2(options.nodeExecutable);
    if (dirname2(root) === root || !lstatSync(entry).isFile() || !lstatSync(node).isFile() || node !== realpathSync2(process.execPath) || !/\.(?:mjs|ts)$/u.test(entry)) throw new Error("PARSER_INVALID_CONFIG");
    this.options = { ...options, root, childEntry: entry, nodeExecutable: node };
    this.limits = resolveSupervisorLimits(options.limits);
    this.ready = this.initializeRoot(root);
    void this.ready.catch(() => {
    });
  }
  submit(submission) {
    const evidence = freshEvidence(randomUUID2());
    if (this.closed) return Promise.resolve({ errorCode: "PARSER_CLOSED", processEvidence: evidence });
    if (!submission || !isTaskIdentity(submission.taskId, submission.generation) || !(submission.bytes instanceof Uint8Array) || !["pdf", "docx", "image"].includes(submission.documentKind) || submission.parserVersion !== DOCUMENT_PARSER_VERSION || this.jobs.has(submission.taskId)) return Promise.resolve({ errorCode: "PARSER_INVALID_REPLY", processEvidence: evidence });
    if (submission.bytes.byteLength > MAX_FILE_SIZE_BYTES) return Promise.resolve({ outcome: { status: "FAILED", code: "DOCUMENT_TOO_LARGE" }, processEvidence: evidence });
    if (this.running >= this.limits.concurrency && this.queue.length >= this.limits.queueLimit) return Promise.resolve({ errorCode: "PARSER_QUEUE_FULL", processEvidence: evidence });
    let finish;
    const promise = new Promise((resolveResult) => {
      finish = resolveResult;
    });
    const job = {
      submission: { ...submission, bytes: Buffer.from(submission.bytes) },
      tempId: evidence.tempId,
      controller: new AbortController(),
      state: "queued",
      promise,
      finish
    };
    this.jobs.set(submission.taskId, job);
    this.queue.push(job);
    this.pump();
    return promise;
  }
  async cancel(taskId) {
    const job = this.jobs.get(taskId);
    if (!job) return;
    job.controller.abort();
    if (job.state === "queued") {
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
      this.jobs.delete(taskId);
      job.finish({ errorCode: "PARSER_CANCELLED", processEvidence: freshEvidence(job.tempId) });
    }
    await job.promise;
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.jobs.keys()].map((taskId) => this.cancel(taskId)));
  }
  async recover() {
    const root = await this.ready;
    const staging = await recoverParserStaging(root);
    let recovered = staging.removed.length;
    const pending = new Set(staging.pending);
    const active = new Set([...this.jobs.values()].map((job) => job.tempId));
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (active.has(entry.name)) continue;
      if (pending.has(entry.name)) continue;
      const directory2 = join2(root, entry.name);
      try {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !TASK_ID_PATTERN.test(entry.name) || await realpath(directory2) !== directory2) throw new Error("unknown");
        const manifestFile = join2(directory2, "owner.json");
        if ((await lstat(manifestFile)).isSymbolicLink()) throw new Error("linked");
        const bytes = await readFile(manifestFile);
        if (bytes.length > 8192) throw new Error("large");
        const manifest = JSON.parse(bytes.toString("utf8"));
        if (!isOwnedManifest(manifest, entry.name) || manifest.pid && processAlive(manifest.pid)) throw new Error("live-or-unknown");
        await assertSafeOwnedTree(directory2, true);
        await rm(directory2, { recursive: true, force: true });
        recovered += 1;
      } catch {
        pending.add(entry.name);
      }
    }
    return { recovered, pending: [...pending].sort() };
  }
  async initializeRoot(root) {
    const missing = [];
    let ancestor = root;
    while (!existsSync2(ancestor)) {
      missing.push(ancestor);
      ancestor = dirname2(ancestor);
    }
    let current = ancestor;
    for (; ; ) {
      if (lstatSync(current).isSymbolicLink()) throw new Error("PARSER_TEMP_FAILED");
      if (dirname2(current) === current) break;
      current = dirname2(current);
    }
    for (const directory2 of missing.reverse()) await mkdir(directory2, { mode: 448 });
    if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error("PARSER_TEMP_FAILED");
    return realpath(root);
  }
  pump() {
    while (!this.closed && this.running < this.limits.concurrency && this.queue.length) {
      const job = this.queue.shift();
      job.state = "running";
      this.running += 1;
      void this.run(job).then(job.finish, () => job.finish({ errorCode: "PARSER_TEMP_FAILED", processEvidence: freshEvidence(job.tempId) })).finally(() => {
        this.jobs.delete(job.submission.taskId);
        this.running -= 1;
        this.pump();
      });
    }
  }
  async run(job) {
    const evidence = freshEvidence(job.tempId);
    let directory2;
    let handle;
    let termination;
    let errorCode;
    let outcome;
    let created = false;
    let directoryAttempted = false;
    const terminate = () => {
      if (!handle) return Promise.resolve();
      termination ??= handle.terminate().then(() => {
        evidence.terminated = true;
      });
      return termination;
    };
    const stop = (code) => {
      errorCode ??= code;
      if (!job.controller.signal.aborted) job.controller.abort();
      void terminate().catch(() => {
      });
    };
    const phase = (value) => {
      evidence.startupPhase = value;
      this.options.testOnly?.onPhase?.({ taskId: job.submission.taskId, tempId: job.tempId, phase: value });
    };
    const onAbort = () => stop("PARSER_CANCELLED");
    job.controller.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => stop("PARSER_TIMEOUT"), this.limits.timeoutMs);
    try {
      const root = await this.ready;
      directory2 = join2(root, job.tempId);
      if (job.controller.signal.aborted) stop("PARSER_CANCELLED");
      if (errorCode) throw new Error("PARSER_STOPPED");
      if (existsSync2(directory2)) throw new Error("PARSER_TEMP_FAILED");
      directoryAttempted = true;
      evidence.cleaned = false;
      phase("private-directory");
      evidence.acl = await secureParserDirectory(directory2, { signal: job.controller.signal });
      created = true;
      const inputPath = join2(directory2, "input.bin");
      const manifest = {
        schemaVersion: "zhijing-parser-job/v1",
        owner: "@zhijing/document-parser",
        tempId: job.tempId,
        taskId: job.submission.taskId,
        generation: job.submission.generation,
        parserVersion: job.submission.parserVersion,
        input: "input.bin",
        createdAt: Date.now()
      };
      await writeFile(join2(directory2, "owner.json"), JSON.stringify(manifest), { mode: 384, flag: "wx" });
      await writeFile(inputPath, job.submission.bytes, { mode: 384, flag: "wx" });
      job.submission.bytes = new Uint8Array();
      if (errorCode) throw new Error("PARSER_STOPPED");
      const request = {
        schemaVersion: CHILD_SCHEMA_VERSION,
        taskId: job.submission.taskId,
        generation: job.submission.generation,
        inputPath,
        documentKind: job.submission.documentKind,
        parserVersion: job.submission.parserVersion
      };
      const requestBytes = Buffer.from(JSON.stringify(request));
      if (requestBytes.length > CHILD_REQUEST_MAX_BYTES) throw new Error("request");
      try {
        phase("process-start");
        handle = await spawnParserProcess({
          nodeExecutable: this.options.nodeExecutable,
          entryPoint: this.options.childEntry,
          args: parserNodeArguments(this.options.childEntry, directory2, this.limits.heapMb),
          cwd: directory2,
          env: parserEnvironment(directory2),
          jobMemoryMb: this.limits.jobMemoryMb,
          signal: job.controller.signal
        });
      } catch {
        stop("PARSER_START_FAILED");
      }
      if (!handle) throw new Error("PARSER_STOPPED");
      const child = handle.process;
      evidence.pid = child.pid;
      evidence.platform = handle.metadata;
      evidence.terminated = false;
      phase("running");
      manifest.pid = child.pid;
      await writeFile(join2(directory2, "owner.json"), JSON.stringify(manifest), { mode: 384 });
      const chunks = [];
      await new Promise((resolveExit) => {
        let closed2 = child.exitCode !== null || child.signalCode !== null;
        const done = () => {
          if (closed2 && (child.stdout.readableEnded || child.stdout.destroyed) && (child.stderr.readableEnded || child.stderr.destroyed)) resolveExit();
        };
        child.stdout.on("data", (chunk) => {
          evidence.stdoutBytes += chunk.length;
          if (evidence.stdoutBytes > this.limits.stdoutMaxBytes) stop("PARSER_OUTPUT_LIMIT");
          else chunks.push(Buffer.from(chunk));
        });
        child.stderr.on("data", (chunk) => {
          evidence.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, evidence.stderrBytes + chunk.length);
        });
        child.stdout.once("end", done);
        child.stderr.once("end", done);
        child.stdout.once("close", done);
        child.stderr.once("close", done);
        child.once("error", () => stop("PARSER_START_FAILED"));
        child.once("close", () => {
          closed2 = true;
          done();
        });
        child.stdin.on("error", () => {
        });
        child.stdin.end(requestBytes);
        this.options.testOnly?.onSpawn?.({ taskId: job.submission.taskId, tempId: job.tempId, pid: child.pid });
        if (errorCode) void terminate().catch(() => {
        });
        setImmediate(done);
      });
      evidence.exitCode = child.exitCode;
      evidence.signal = child.signalCode;
      if (job.controller.signal.aborted) stop("PARSER_CANCELLED");
      if (!errorCode && child.exitCode !== 0) stop("PARSER_ABNORMAL_EXIT");
      if (!errorCode) {
        try {
          outcome = decodeChildReply(Buffer.concat(chunks), request);
        } catch {
          stop("PARSER_INVALID_REPLY");
        }
      }
    } catch {
      errorCode ??= "PARSER_TEMP_FAILED";
    } finally {
      clearTimeout(timeout);
      job.controller.signal.removeEventListener("abort", onAbort);
      let terminationConfirmed = true;
      try {
        await terminate();
      } catch {
        terminationConfirmed = false;
        evidence.terminated = false;
        errorCode = "PARSER_CLEANUP_PENDING";
      }
      if (terminationConfirmed) {
        try {
          await handle?.cleanup();
        } catch {
          errorCode = "PARSER_CLEANUP_PENDING";
        }
      }
      const childPid = handle?.metadata.childPid;
      if (typeof childPid === "number" && Number.isSafeInteger(childPid)) evidence.childPid = childPid;
      if (directoryAttempted && directory2) {
        try {
          if (!terminationConfirmed) throw new Error("live");
          if (created) {
            await assertSafeOwnedTree(directory2, false);
            await rm(directory2, { recursive: true, force: true });
          } else if (existsSync2(directory2)) {
            const stat = await lstat(directory2);
            if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory2) !== directory2 || (await readdir(directory2)).length) throw new Error("unknown");
            await rmdir(directory2);
          }
        } catch {
          errorCode = "PARSER_CLEANUP_PENDING";
        }
        try {
          await lstat(directory2);
          evidence.cleaned = false;
          errorCode = "PARSER_CLEANUP_PENDING";
        } catch (error) {
          evidence.cleaned = error.code === "ENOENT";
          if (!evidence.cleaned) errorCode = "PARSER_CLEANUP_PENDING";
        }
      }
    }
    return { ...errorCode ? { errorCode } : { outcome }, processEvidence: evidence };
  }
};
function freshEvidence(tempId) {
  return {
    tempId,
    terminated: true,
    cleaned: true,
    stdoutBytes: 0,
    stderrBytes: 0,
    permissionModel: "node-read-only-code-and-private-input",
    nativeAddonsAllowed: true
  };
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function isOwnedManifest(value, tempId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value;
  const keys = ["schemaVersion", "owner", "tempId", "taskId", "generation", "parserVersion", "input", "createdAt", ...item.pid === void 0 ? [] : ["pid"]];
  return Object.keys(item).length === keys.length && keys.every((key) => Object.hasOwn(item, key)) && item.schemaVersion === "zhijing-parser-job/v1" && item.owner === "@zhijing/document-parser" && item.tempId === tempId && isTaskIdentity(item.taskId, item.generation) && item.parserVersion === DOCUMENT_PARSER_VERSION && item.input === "input.bin" && Number.isSafeInteger(item.createdAt) && Number(item.createdAt) > 0 && (item.pid === void 0 || Number.isSafeInteger(item.pid) && Number(item.pid) > 0);
}
async function assertSafeOwnedTree(directory2, recovery) {
  if ((await lstat(directory2)).isSymbolicLink() || await realpath(directory2) !== directory2) throw new Error("linked");
  for (const name of await readdir(directory2)) {
    if (name !== "input.bin" && name !== "owner.json" && !(recovery && PLATFORM_ENTRIES.has(name))) throw new Error("unknown");
    const file = join2(directory2, name), stat = await lstat(file);
    const rel = relative(directory2, file);
    if (rel.startsWith(`..${sep2}`) || isAbsolute(rel) || stat.isSymbolicLink()) throw new Error("linked");
    if (stat.isDirectory()) {
      if (!recovery || name !== "_platform-compile") throw new Error("unknown");
      await assertBoundedRegularTree(file, 0, { count: 0 });
    } else if (!stat.isFile()) throw new Error("nonregular");
  }
}
async function assertBoundedRegularTree(directory2, depth, counter) {
  if (depth > 8) throw new Error("deep");
  for (const name of await readdir(directory2)) {
    if (++counter.count > 1e3) throw new Error("large");
    const file = join2(directory2, name), stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error("linked");
    if (stat.isDirectory()) await assertBoundedRegularTree(file, depth + 1, counter);
    else if (!stat.isFile()) throw new Error("nonregular");
  }
}

// src/materials/vendor/acquisition/windows-ocr.ts
import fs2 from "node:fs";
import path2 from "node:path";
import { createHash as createHash2, randomUUID as randomUUID3 } from "node:crypto";
import { spawn as spawn2 } from "node:child_process";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/materials/vendor/contracts/material-source.ts
import { Type as Type2 } from "@sinclair/typebox";
import { Value as Value3 } from "@sinclair/typebox/value";
var fixed = { additionalProperties: false };
var nullableText = (maximum) => Type2.Union([Type2.String({ minLength: 1, maxLength: maximum }), Type2.Null()]);
var box = Type2.Object({ x: Type2.Number({ minimum: 0 }), y: Type2.Number({ minimum: 0 }), width: Type2.Number({ minimum: 0 }), height: Type2.Number({ minimum: 0 }) }, fixed);
var word = Type2.Object({ text: Type2.String({ maxLength: 1e3 }), box }, fixed);
var line = Type2.Object({
  text: Type2.String({ minLength: 1, maxLength: 1e4 }),
  startOffset: Type2.Integer({ minimum: 0, maximum: 2e5 }),
  endOffset: Type2.Integer({ minimum: 1, maximum: 2e5 }),
  box,
  words: Type2.Array(word, { maxItems: 1e3 })
}, fixed);
var MaterialRecognizedFieldsSchema = Type2.Object({
  jobTitle: nullableText(500),
  company: nullableText(500),
  salary: nullableText(500),
  location: nullableText(500),
  responsibilities: nullableText(1e5),
  requirements: nullableText(1e5)
}, fixed);
var MaterialOcrResultSchema = Type2.Object({
  engine: Type2.Literal("windows-media-ocr"),
  language: Type2.String({ minLength: 1, maxLength: 40 }),
  width: Type2.Integer({ minimum: 1, maximum: 1e4 }),
  height: Type2.Integer({ minimum: 1, maximum: 1e4 }),
  lines: Type2.Array(line, { minItems: 1, maxItems: 1e4 })
}, fixed);
var MaterialAcquisitionSourceSchema = Type2.Object({
  method: Type2.Union([Type2.Literal("public-html-v1"), Type2.Literal("windows-ocr-v1")]),
  inputKind: Type2.Union([Type2.Literal("url"), Type2.Literal("uploaded-image"), Type2.Literal("pasted-image"), Type2.Literal("browser-capture")]),
  sourceUrl: nullableText(2048),
  finalUrl: nullableText(2048),
  pageTitle: nullableText(500),
  capturedAt: Type2.Integer({ minimum: 1 }),
  contentHash: Type2.String({ pattern: "^[a-f0-9]{64}$" }),
  originalFileId: nullableText(160),
  originalHash: Type2.Union([Type2.String({ pattern: "^[a-f0-9]{64}$" }), Type2.Null()]),
  fields: MaterialRecognizedFieldsSchema,
  ocr: Type2.Union([MaterialOcrResultSchema, Type2.Null()])
}, fixed);

// src/materials/vendor/acquisition/windows-ocr.ts
import { Value as Value4 } from "@sinclair/typebox/value";

// src/materials/vendor/acquisition/image-policy.ts
var SCREENSHOT_MAX_BYTES = 25 * 1024 * 1024;
var SCREENSHOT_MAX_PIXELS = 25e6;
var reject = () => {
  throw new Error("MATERIALS_IMAGE_REJECTED");
};
function checkAcquisitionImage(input, declared) {
  if (!(input instanceof Uint8Array) || input.byteLength < 20 || input.byteLength > SCREENSHOT_MAX_BYTES) reject();
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let mimeType, width = 0, height = 0;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") reject();
    mimeType = "image/png";
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    mimeType = "image/jpeg";
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 255) reject();
      while (bytes[offset] === 255) offset++;
      const nextMarker = bytes[offset++];
      if (nextMarker === void 0 || nextMarker === 0) return reject();
      const marker = nextMarker;
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) reject();
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) reject();
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) reject();
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else return reject();
  if (declared && declared !== mimeType || !width || !height || width > 1e4 || height > 1e4 || width * height > SCREENSHOT_MAX_PIXELS) reject();
  return { mimeType, width, height };
}

// src/materials/vendor/acquisition/windows-ocr.ts
var quote = (text) => "'" + text.replaceAll("'", "''") + "'";
var failure = (code = "MATERIALS_OCR_FAILED") => new Error(code);
var equalPath = (one, two) => process.platform === "win32" ? one.toLowerCase() === two.toLowerCase() : one === two;
function safeDirectory(directory2) {
  if (!path2.isAbsolute(directory2) || /[\u0000-\u001f]/u.test(directory2)) throw failure();
  for (let parent = directory2; ; parent = path2.dirname(parent)) {
    if (fs2.existsSync(parent)) {
      const stat = fs2.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !equalPath(fs2.realpathSync.native(parent), parent)) throw failure();
    }
    if (path2.dirname(parent) === parent) break;
  }
  fs2.mkdirSync(directory2, { recursive: true, mode: 448 });
  if (!equalPath(fs2.realpathSync.native(directory2), directory2) || fs2.lstatSync(directory2).isSymbolicLink()) throw failure();
}
function decodeOutput(raw, expected) {
  let result;
  try {
    result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw).replace(/^\uFEFF/u, "").trim());
  } catch {
    throw failure();
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw failure();
  if (result.ok === false) {
    throw failure(["MATERIALS_OCR_UNAVAILABLE", "MATERIALS_IMAGE_REJECTED"].includes(String(result.code)) ? String(result.code) : void 0);
  }
  if (result.ok !== true || result.width !== expected.width || result.height !== expected.height || typeof result.language !== "string" || !Array.isArray(result.lines) || result.lines.length > 1e4) throw failure();
  if (!result.lines.length) throw failure("MATERIALS_OCR_NO_TEXT");
  const lines = [];
  let text = "";
  for (const value of result.lines) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
    const line2 = value;
    if (typeof line2.text !== "string" || !line2.text.trim() || line2.text.length > 1e4 || /[\r\n\u0000]/u.test(line2.text) || !Array.isArray(line2.words) || !line2.words.length || line2.words.length > 1e3) throw failure();
    const words = [];
    for (const item of line2.words) {
      if (!item || typeof item !== "object") throw failure();
      const word2 = item;
      if (typeof word2.text !== "string" || !word2.text || word2.text.length > 1e3 || !line2.text.includes(word2.text) || !word2.box || typeof word2.box !== "object") throw failure();
      const box2 = word2.box, fields = ["x", "y", "width", "height"];
      if (fields.some((key) => typeof box2[key] !== "number" || !Number.isFinite(box2[key]))) throw failure();
      const rectangle = box2;
      if (rectangle.x < 0 || rectangle.y < 0 || rectangle.width <= 0 || rectangle.height <= 0 || rectangle.x + rectangle.width > expected.width + 0.01 || rectangle.y + rectangle.height > expected.height + 0.01) throw failure();
      words.push({ text: word2.text, box: { ...rectangle } });
    }
    if (text) text += "\n";
    const startOffset = text.length;
    text += line2.text;
    if (text.length > 2e5) throw failure();
    const left = Math.min(...words.map((word2) => word2.box.x)), top = Math.min(...words.map((word2) => word2.box.y));
    const right = Math.max(...words.map((word2) => word2.box.x + word2.box.width)), bottom = Math.max(...words.map((word2) => word2.box.y + word2.box.height));
    lines.push({ text: line2.text, startOffset, endOffset: text.length, box: { x: left, y: top, width: right - left, height: bottom - top }, words });
  }
  const ocr = { engine: "windows-media-ocr", language: result.language, width: expected.width, height: expected.height, lines };
  try {
    if (!Value4.Check(MaterialOcrResultSchema, ocr)) throw failure();
  } catch {
    throw failure();
  }
  return { text, ocr };
}
function createWindowsOcrWorker(options) {
  const root = path2.resolve(options.root), timeoutMs = options.timeoutMs ?? 3e4, outputLimit = options.outputLimit ?? 4 * 1024 * 1024;
  const language = options.language ?? "auto";
  if (!path2.isAbsolute(options.root) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 6e4 || !Number.isSafeInteger(outputLimit) || outputLimit < 1024 || outputLimit > 8 * 1024 * 1024 || !/^[A-Za-z0-9-]{2,40}$/u.test(language)) throw failure();
  let closed2 = false;
  const jobs = /* @__PURE__ */ new Set();
  let closing;
  return {
    recognize(input, signal) {
      if (closed2) return Promise.reject(failure("MATERIALS_CLOSED"));
      if (signal.aborted) return Promise.reject(failure("MATERIALS_ACQUISITION_CANCELLED"));
      if (jobs.size >= 2) return Promise.reject(failure());
      const bytes = Buffer.from(input.bytes), dimensions = checkAcquisitionImage(bytes, input.mimeType);
      const inputHash = createHash2("sha256").update(bytes).digest("hex");
      if (process.platform !== "win32" && !options.testOnly) return Promise.reject(failure("MATERIALS_OCR_UNAVAILABLE"));
      let jobDirectory, inputPath, inputIdentity, directoryIdentity;
      try {
        safeDirectory(root);
        jobDirectory = path2.join(root, randomUUID3());
        fs2.mkdirSync(jobDirectory, { mode: 448 });
        directoryIdentity = fs2.lstatSync(jobDirectory);
        inputPath = path2.join(jobDirectory, "input.bin");
        fs2.writeFileSync(inputPath, bytes, { flag: "wx", mode: 384 });
        inputIdentity = fs2.lstatSync(inputPath);
      } catch {
        return Promise.reject(failure());
      }
      let child, stopped;
      let settle, reject2;
      const completion = new Promise((resolve2, failed) => {
        settle = resolve2;
        reject2 = failed;
      });
      const stop = (code) => {
        stopped ??= code;
        if (child && child.exitCode === null && child.signalCode === null) child.kill();
      };
      const job = { stop: () => stop("MATERIALS_ACQUISITION_CANCELLED"), completion };
      jobs.add(job);
      const cancel = () => stop("MATERIALS_ACQUISITION_CANCELLED");
      signal.addEventListener("abort", cancel, { once: true });
      const stdout = [];
      let stdoutBytes = 0, stderrBytes = 0, finished = false;
      const cleanup = () => {
        const relative2 = path2.relative(root, jobDirectory);
        if (!relative2 || relative2.startsWith("..") || path2.isAbsolute(relative2) || !equalPath(fs2.realpathSync.native(jobDirectory), jobDirectory)) throw failure();
        const directory2 = fs2.lstatSync(jobDirectory), original = fs2.lstatSync(inputPath);
        if (directory2.isSymbolicLink() || directory2.dev !== directoryIdentity.dev || directory2.ino !== directoryIdentity.ino || !original.isFile() || original.isSymbolicLink() || original.nlink !== 1 || original.dev !== inputIdentity.dev || original.ino !== inputIdentity.ino) throw failure();
        const entries = fs2.readdirSync(jobDirectory);
        if (entries.some((entry) => entry !== "input.bin") || original.size !== bytes.length) throw failure();
        const fd = fs2.openSync(inputPath, "r"), checked = Buffer.alloc(bytes.length);
        try {
          const opened = fs2.fstatSync(fd);
          if (opened.dev !== inputIdentity.dev || opened.ino !== inputIdentity.ino || opened.nlink !== 1 || opened.size !== bytes.length) throw failure();
          let offset = 0;
          while (offset < checked.length) {
            const read = fs2.readSync(fd, checked, offset, checked.length - offset, offset);
            if (!read) throw failure();
            offset += read;
          }
          if (fs2.readSync(fd, Buffer.alloc(1), 0, 1, checked.length) !== 0 || createHash2("sha256").update(checked).digest("hex") !== inputHash) throw failure();
        } finally {
          fs2.closeSync(fd);
        }
        fs2.unlinkSync(inputPath);
        fs2.rmdirSync(jobDirectory);
      };
      const finish = (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        jobs.delete(job);
        let result, error;
        try {
          if (stopped) throw failure(stopped);
          result = decodeOutput(Buffer.concat(stdout), dimensions);
          if (code !== 0) throw failure();
        } catch (cause) {
          error = cause instanceof Error ? cause : failure();
        }
        let cleaned = false;
        try {
          cleanup();
          cleaned = true;
        } catch {
          error = failure();
        }
        try {
          options.onProcess?.({
            ...child?.pid ? { pid: child.pid } : {},
            exitCode: code,
            stdoutBytes,
            stderrBytes,
            cleaned,
            stopped: !!stopped,
            windowsHide: true,
            modelRequests: 0
          });
        } catch {
        }
        if (error || !result) reject2(error ?? failure());
        else settle(result);
      };
      const timer = setTimeout(() => stop("MATERIALS_OCR_FAILED"), timeoutMs);
      try {
        const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
        const source = fs2.readFileSync(options.scriptPath ?? fileURLToPath2(new URL("./windows-ocr.ps1", import.meta.url)), "utf8").replace(/^\uFEFF/u, "");
        const command = `$ocrInputPath=${quote(inputPath)}; $ocrLanguage=${quote(language)};
${source}`;
        const executable = options.testOnly?.executable ?? path2.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
        const args = options.testOnly?.arguments ?? ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
        child = spawn2(executable, args, {
          cwd: jobDirectory,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: root, TMP: root }
        });
        job.child = child;
        child.stdout?.on("data", (chunk) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > outputLimit) stop("MATERIALS_OCR_FAILED");
          else stdout.push(chunk);
        });
        child.stderr?.on("data", (chunk) => {
          stderrBytes += chunk.length;
          if (stderrBytes > 65536) stop("MATERIALS_OCR_FAILED");
        });
        child.once("error", () => {
          stopped ??= "MATERIALS_OCR_UNAVAILABLE";
        });
        child.once("close", (code) => finish(code));
        if (child.pid) {
          try {
            options.testOnly?.onSpawn?.(child.pid);
          } catch {
            stop("MATERIALS_OCR_FAILED");
          }
        }
        if (signal.aborted || closed2) cancel();
      } catch {
        stopped ??= "MATERIALS_OCR_UNAVAILABLE";
        finish(null);
      }
      return completion;
    },
    close() {
      if (closing) return closing;
      closed2 = true;
      const own = [...jobs];
      for (const job of own) job.stop();
      return closing = Promise.allSettled(own.map((job) => job.completion)).then(() => {
      });
    }
  };
}

// src/materials/vendor/acquisition/http-job-source.ts
import http from "node:http";
import https from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isIP as isIP2 } from "node:net";

// src/materials/vendor/acquisition/html-job-extractor.ts
import { parse as parse2, parseFragment } from "parse5";
import { createHash as createHash3 } from "node:crypto";

// src/materials/vendor/acquisition/job-fields.ts
function recognizedFieldsFromText(text) {
  const lines = text.split(/\r?\n/u).map((line2) => line2.trim()).filter(Boolean);
  const labelled = (labels) => lines.map((line2) => new RegExp(`^(?:${labels.join("|")})[\uFF1A:]\\s*(.+)$`, "u").exec(line2)?.[1]?.trim()).find(Boolean) ?? null;
  const section = (labels) => {
    const start = lines.findIndex((line2) => new RegExp(`^(?:${labels.join("|")})[\uFF1A:]?\\s*$`, "u").test(line2));
    if (start < 0) return labelled(labels);
    const following = [];
    for (const line2 of lines.slice(start + 1)) {
      if (/^(?:岗位职责|职位描述|工作职责|任职要求|岗位要求|职位要求|福利待遇|公司介绍)[：:]?$/u.test(line2)) break;
      following.push(line2);
    }
    const value = following.join("\n");
    return value && text.includes(value) ? value : null;
  };
  const first = lines.find((line2) => line2.length <= 100 && !/登录|验证|扫码|职位搜索|招聘平台/u.test(line2)) ?? null;
  const salary = labelled(["\u85AA\u8D44", "\u85AA\u8D44\u8303\u56F4", "\u85AA\u916C", "\u5DE5\u8D44"]) ?? lines.find((line2) => /(?:\d[\d.,]*\s*[kKwW千万元]\s*[-—~至]\s*\d[\d.,]*\s*[kKwW千万元]|薪资面议)/u.test(line2)) ?? null;
  const result = {
    jobTitle: labelled(["\u5C97\u4F4D\u540D\u79F0", "\u804C\u4F4D\u540D\u79F0", "\u62DB\u8058\u804C\u4F4D"]) ?? first,
    company: labelled(["\u516C\u53F8", "\u516C\u53F8\u540D\u79F0", "\u62DB\u8058\u516C\u53F8"]),
    salary,
    location: labelled(["\u5DE5\u4F5C\u5730\u70B9", "\u5DE5\u4F5C\u5730\u5740", "\u5730\u70B9", "\u57CE\u5E02"]),
    responsibilities: section(["\u5C97\u4F4D\u804C\u8D23", "\u5DE5\u4F5C\u804C\u8D23", "\u804C\u4F4D\u63CF\u8FF0"]),
    requirements: section(["\u4EFB\u804C\u8981\u6C42", "\u5C97\u4F4D\u8981\u6C42", "\u804C\u4F4D\u8981\u6C42"])
  };
  for (const key of Object.keys(result)) {
    const value = result[key], maximum = ["responsibilities", "requirements"].includes(key) ? 1e5 : 500;
    if (value && (value.length > maximum || !text.includes(value))) result[key] = null;
  }
  return result;
}

// src/materials/vendor/acquisition/public-url-policy.ts
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
var deniedV4 = new BlockList();
var deniedV6 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
]) deniedV4.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8]
]) deniedV6.addSubnet(address, prefix, "ipv6");
var globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
function isPublicJobAddress(address) {
  const family = isIP(address);
  return family === 4 ? !deniedV4.check(address, "ipv4") : family === 6 && globalV6.check(address, "ipv6") && !deniedV6.check(address, "ipv6");
}
function normalizeJobUrl(value) {
  const reject2 = () => {
    throw new Error("MATERIALS_URL_REJECTED");
  };
  if (typeof value !== "string" || !value || value.length > 2048 || value !== value.trim() || /[\\\u0000-\u0020\u007f]/u.test(value)) reject2();
  let url;
  try {
    url = new URL(value);
  } catch {
    return reject2();
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) reject2();
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!hostname || hostname.includes("%") || hostname.endsWith(".") || hostname === "localhost" || /\.(?:localhost|local|internal|lan|home|onion|invalid|test)$/u.test(hostname)) reject2();
  if (isIP(hostname) && !isPublicJobAddress(hostname)) reject2();
  url.hash = "";
  return url;
}
var defaultResolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((row) => ({ address: row.address, family: row.family }));
async function abortable(operation, signal) {
  if (!signal) return operation;
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([operation, new Promise((_, reject2) => {
      abort = () => reject2(new Error("MATERIALS_ACQUISITION_CANCELLED"));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
async function resolvePublicJobUrl(value, options = {}) {
  const url = normalizeJobUrl(value), hostname = url.hostname.replace(/^\[|\]$/gu, "");
  options.signal?.throwIfAborted();
  let addresses;
  if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) }];
  else {
    try {
      addresses = await abortable((options.resolver ?? defaultResolver)(hostname), options.signal);
    } catch {
      throw new Error(options.signal?.aborted ? "MATERIALS_ACQUISITION_CANCELLED" : "MATERIALS_FETCH_FAILED");
    }
  }
  if (!addresses.length || addresses.length > 32 || addresses.some((row) => !isPublicJobAddress(row.address) || isIP(row.address) !== row.family))
    throw new Error("MATERIALS_URL_REJECTED");
  return { url, hostname, addresses, selected: addresses[0] };
}
function sanitizeJobSourceUrl(value) {
  const url = normalizeJobUrl(value);
  for (const key of [...url.searchParams.keys()]) if (/^(?:utm_|ka$|lid$|securityid$|token$|access_token$|refresh_token$|auth$|password$|session|cookie|code$|seed$|ts$)/iu.test(key)) url.searchParams.delete(key);
  return url.href;
}
function isJobVerificationUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return true;
  }
  return /\/(?:passport|security|captcha|login|signin|verify|verification|challenge)(?:[/.]|$)/iu.test(url.pathname);
}

// src/materials/vendor/acquisition/html-job-extractor.ts
var ignored = /* @__PURE__ */ new Set(["script", "style", "noscript", "template", "svg", "nav", "footer", "form", "button", "input"]);
var block = /* @__PURE__ */ new Set(["p", "div", "section", "article", "main", "h1", "h2", "h3", "li", "br", "tr"]);
function children(node) {
  return "childNodes" in node ? node.childNodes : [];
}
function attribute(node, name) {
  return "attrs" in node ? node.attrs.find((item) => item.name === name)?.value ?? "" : "";
}
function tag(node) {
  return "tagName" in node ? node.tagName : "";
}
function visibleText(node, budget) {
  const chunks = [], stack = [{ node }];
  let visited = 0;
  while (stack.length) {
    const entry = stack.pop();
    if (++visited > 1e5 || --budget.remaining < 0) throw new Error("MATERIALS_PAGE_TOO_LARGE");
    if (entry.end) {
      chunks.push("\n");
      continue;
    }
    const current = entry.node, name = tag(current);
    if (ignored.has(name) || attribute(current, "aria-hidden") === "true" || "attrs" in current && current.attrs.some((x) => x.name === "hidden")) continue;
    if ("value" in current && current.nodeName === "#text") chunks.push(current.value);
    else {
      if (block.has(name)) chunks.push("\n");
      if (block.has(name)) stack.push({ node: current, end: true });
      for (const child of [...children(current)].reverse()) stack.push({ node: child });
    }
  }
  return chunks.join("").replace(/\u00a0/gu, " ").replace(/[\t ]+/gu, " ").replace(/ *\n */gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}
function allNodes(document) {
  const result = [], stack = [document];
  while (stack.length) {
    const node = stack.pop();
    if (result.length >= 1e5) throw new Error("MATERIALS_PAGE_TOO_LARGE");
    result.push(node);
    const list = children(node);
    for (let index = list.length - 1; index >= 0; index--) stack.push(list[index]);
  }
  return result;
}
function structuredPosting(value) {
  const stack = [value];
  let visited = 0;
  while (stack.length) {
    const row = stack.pop();
    if (++visited > 1e4) return null;
    if (!row || typeof row !== "object") continue;
    if (Array.isArray(row)) {
      if (row.length > 1e4) return null;
      for (const child of row) stack.push(child);
      continue;
    }
    const record = row, types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
    if (types.includes("JobPosting")) return record;
    for (const [key, child] of Object.entries(record)) if (key === "@graph" || key === "mainEntity" || key === "itemListElement" || key === "item") stack.push(child);
  }
  return null;
}
function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
function checkMarkupBudget(html) {
  let count = 0;
  for (const _match of html.matchAll(/<[A-Za-z!]/gu)) {
    if (++count > 2e4) throw new Error("MATERIALS_PAGE_TOO_LARGE");
  }
}
function extractPublicJob(html, sourceUrl, finalUrl, capturedAt = Date.now()) {
  if (Buffer.byteLength(html, "utf8") > 2 * 1024 * 1024) throw new Error("MATERIALS_PAGE_TOO_LARGE");
  checkMarkupBudget(html);
  if (isJobVerificationUrl(finalUrl)) throw new Error("MATERIALS_SITE_VERIFICATION");
  const document = parse2(html), nodes = allNodes(document), budget = { remaining: 2e5 };
  const titleNode = nodes.find((node) => tag(node) === "title"), pageTitle = titleNode ? visibleText(titleNode, budget).slice(0, 500) || null : null;
  const heading = nodes.find((node) => tag(node) === "h1"), headingText = heading ? visibleText(heading, budget) : "";
  const fullText = visibleText(document, budget);
  if (/安全验证|完成验证|验证码|请先登录|登录后查看|验证你的身份|verify you are human|access denied|captcha|sign in to continue|just a moment/iu.test((pageTitle ?? "") + "\n" + headingText) || /拖动滑块|扫码登录|请完成验证|访问过于频繁|verify you are human|checking your browser|enable javascript and cookies to continue/iu.test(fullText)) throw new Error("MATERIALS_SITE_VERIFICATION");
  let posting = null;
  for (const node of nodes) if (tag(node) === "script" && attribute(node, "type").toLowerCase() === "application/ld+json") {
    const raw = children(node).map((child) => "value" in child ? child.value : "").join("");
    if (raw.length > 5e5) continue;
    try {
      posting = structuredPosting(JSON.parse(raw));
    } catch {
    }
    if (posting) break;
  }
  let jobTitle = posting ? textValue(posting.title) : headingText;
  let text = "", metadata = "";
  if (posting) {
    const description = textValue(posting.description), organization = posting.hiringOrganization;
    const company = organization && typeof organization === "object" && !Array.isArray(organization) ? textValue(organization.name) : "";
    const location = posting.jobLocation, locationRow = Array.isArray(location) ? location[0] : location;
    const address = locationRow && typeof locationRow === "object" ? locationRow.address : null;
    const locality = address && typeof address === "object" ? ["addressRegion", "addressLocality", "streetAddress"].map((key) => textValue(address[key])).filter(Boolean).join(" ") : "";
    metadata = [jobTitle ? "\u5C97\u4F4D\u540D\u79F0\uFF1A" + jobTitle : "", company ? "\u516C\u53F8\u540D\u79F0\uFF1A" + company : "", locality ? "\u5DE5\u4F5C\u5730\u70B9\uFF1A" + locality : ""].filter(Boolean).join("\n");
    checkMarkupBudget(description);
    text = visibleText(parseFragment(description), budget);
  }
  if (!text) {
    const candidates = nodes.filter((node) => ["article", "main"].includes(tag(node)) || /(?:^|\s)(?:job-sec-text|job-description|job-detail-section|job-detail-description|job-desc)(?:\s|$)/iu.test(attribute(node, "class")) || ["jobDescription", "job-description"].includes(attribute(node, "id")));
    if (candidates.length > 32) throw new Error("MATERIALS_PAGE_TOO_LARGE");
    const ranked = candidates.map((node) => ({ text: visibleText(node, budget), priority: ["article", "main"].includes(tag(node)) ? 1 : 2 })).filter((row) => row.text.length >= 30).sort((a, b) => b.priority - a.priority || b.text.length - a.text.length);
    text = ranked[0]?.text ?? "";
  }
  if (text.length < 30 || !posting && !/岗位职责|任职要求|职位描述|岗位要求|responsibilities|qualifications|requirements/iu.test(text)) throw new Error("MATERIALS_NO_JOB_TEXT");
  jobTitle = jobTitle.slice(0, 500).trim();
  if (metadata) text = metadata + "\n\n" + text;
  else if (jobTitle && !text.includes(jobTitle)) text = "\u5C97\u4F4D\u540D\u79F0\uFF1A" + jobTitle + "\n\n" + text;
  text = text.replace(/\r\n?/gu, "\n");
  if (text.length > 2e5 || text.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw new Error("MATERIALS_PAGE_TOO_LARGE");
  const source = {
    method: "public-html-v1",
    inputKind: "url",
    sourceUrl: sanitizeJobSourceUrl(sourceUrl),
    finalUrl: sanitizeJobSourceUrl(finalUrl),
    pageTitle,
    capturedAt,
    contentHash: createHash3("sha256").update(text).digest("hex"),
    originalFileId: null,
    originalHash: null,
    fields: recognizedFieldsFromText(text),
    ocr: null
  };
  return { title: jobTitle || source.fields.jobTitle || "\u5C97\u4F4D\u94FE\u63A5\u8D44\u6599", text, source };
}

// src/materials/vendor/acquisition/http-job-source.ts
function cancelled() {
  return new Error("MATERIALS_ACQUISITION_CANCELLED");
}
async function readResponse(response, maximum, signal) {
  const length = Number(response.headers["content-length"]);
  if (Number.isFinite(length) && length > maximum) {
    response.destroy();
    throw new Error("MATERIALS_PAGE_TOO_LARGE");
  }
  const encoding = (response.headers["content-encoding"] ?? "identity").toLowerCase().trim();
  const decoder = encoding === "gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : null;
  if (!decoder && encoding !== "identity") {
    response.destroy();
    throw new Error("MATERIALS_FETCH_FAILED");
  }
  let compressed = 0, failure2;
  response.on("data", (chunk) => {
    compressed += chunk.length;
    if (compressed > maximum) {
      failure2 = new Error("MATERIALS_PAGE_TOO_LARGE");
      response.destroy(failure2);
      decoder?.destroy(failure2);
    }
  });
  response.on("error", (error) => decoder?.destroy(error));
  const stream = decoder ? response.pipe(decoder) : response;
  const chunks = [];
  let bytes = 0;
  const abort = () => {
    const error = cancelled();
    response.destroy(error);
    decoder?.destroy(error);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maximum) {
        failure2 = new Error("MATERIALS_PAGE_TOO_LARGE");
        response.destroy();
        decoder?.destroy();
        throw failure2;
      }
      chunks.push(buffer);
    }
    if (failure2) throw failure2;
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
var pinnedJobHttpTransport = ({ resolved, signal, maximumBytes }) => new Promise((resolve2, reject2) => {
  const selected = resolved.selected;
  const lookup2 = (_hostname, options, callback) => {
    if (signal.aborted) {
      callback(cancelled(), "", 0);
      return;
    }
    if (typeof options === "object" && options.all) callback(null, [selected]);
    else callback(null, selected.address, selected.family);
  };
  const request = (resolved.url.protocol === "https:" ? https : http).request(resolved.url, {
    method: "GET",
    agent: false,
    family: selected.family,
    lookup: lookup2,
    ...resolved.url.protocol === "https:" && !isIP2(resolved.hostname) ? { servername: resolved.hostname } : {},
    headers: { Accept: "text/html,application/xhtml+xml", "Accept-Encoding": "gzip, deflate, br", "User-Agent": "ZhijingAI/0.1 JobMaterialImport" }
  }, (response) => {
    const status = response.statusCode ?? 0;
    const headers = { "content-type": response.headers["content-type"], location: response.headers.location };
    if (status >= 300 && status < 400 || [401, 403, 429].includes(status)) {
      response.destroy();
      resolve2({ status, headers, body: new Uint8Array() });
      return;
    }
    void readResponse(response, maximumBytes, signal).then((body) => resolve2({ status, headers, body }), reject2);
  });
  const abort = () => request.destroy(cancelled());
  signal.addEventListener("abort", abort, { once: true });
  request.on("close", () => signal.removeEventListener("abort", abort));
  request.on("error", reject2);
  if (signal.aborted) abort();
  else request.end();
});
function decodeHtml(body, contentType) {
  const headerEncoding = /charset\s*=\s*["']?([^;\s"']+)/iu.exec(contentType)?.[1];
  const meta = Buffer.from(body.subarray(0, 4096)).toString("ascii");
  const encoding = (headerEncoding ?? /charset\s*=\s*["']?([a-zA-Z0-9_-]+)/iu.exec(meta)?.[1] ?? "utf-8").toLowerCase();
  if (!["utf-8", "utf8", "gbk", "gb2312", "gb18030", "big5", "windows-1252", "iso-8859-1"].includes(encoding)) throw new Error("MATERIALS_FETCH_FAILED");
  try {
    return new TextDecoder(encoding).decode(body);
  } catch {
    throw new Error("MATERIALS_FETCH_FAILED");
  }
}
function createHttpJobSource(options = {}) {
  const maximum = options.maximumBytes ?? 2 * 1024 * 1024, redirects = options.maximumRedirects ?? 3;
  return async (input, outerSignal) => {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    outerSignal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? 2e4);
    try {
      outerSignal.throwIfAborted();
      let target = input;
      for (let count = 0; count <= redirects; count++) {
        const resolved = await resolvePublicJobUrl(target, { resolver: options.resolver, signal: controller.signal });
        if (isJobVerificationUrl(resolved.url.href)) throw new Error("MATERIALS_SITE_VERIFICATION");
        const response = await abortable((options.transport ?? pinnedJobHttpTransport)({ resolved, signal: controller.signal, maximumBytes: maximum }), controller.signal);
        controller.signal.throwIfAborted();
        if ([401, 403, 429].includes(response.status)) throw new Error("MATERIALS_SITE_VERIFICATION");
        if (response.status >= 300 && response.status < 400) {
          if (!response.headers.location || count === redirects) throw new Error("MATERIALS_FETCH_FAILED");
          const next = new URL(response.headers.location, resolved.url);
          if (isJobVerificationUrl(next.href)) throw new Error("MATERIALS_SITE_VERIFICATION");
          if (resolved.url.protocol === "https:" && next.protocol !== "https:") throw new Error("MATERIALS_URL_REJECTED");
          target = next.href;
          continue;
        }
        if (response.status < 200 || response.status >= 300 || !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(response.headers["content-type"] ?? "")) throw new Error("MATERIALS_FETCH_FAILED");
        if (response.body.byteLength > maximum) throw new Error("MATERIALS_PAGE_TOO_LARGE");
        return extractPublicJob(decodeHtml(response.body, response.headers["content-type"]), input, resolved.url.href, (options.now ?? Date.now)());
      }
      throw new Error("MATERIALS_FETCH_FAILED");
    } catch (error) {
      if (controller.signal.aborted || outerSignal.aborted) throw new Error(timedOut ? "MATERIALS_FETCH_TIMEOUT" : "MATERIALS_ACQUISITION_CANCELLED");
      const message = error instanceof Error ? error.message : "";
      if (/^MATERIALS_(?:URL_REJECTED|FETCH_FAILED|PAGE_TOO_LARGE|SITE_VERIFICATION|NO_JOB_TEXT)$/u.test(message)) throw error;
      throw new Error("MATERIALS_FETCH_FAILED");
    } finally {
      clearTimeout(timer);
      outerSignal.removeEventListener("abort", abort);
    }
  };
}
export {
  DOCUMENT_PARSER_VERSION,
  ParserSupervisor,
  checkAcquisitionImage,
  createHttpJobSource,
  createWindowsOcrWorker,
  extractPublicJob,
  isPublicJobAddress,
  normalizeJobUrl,
  pinnedJobHttpTransport,
  resolvePublicJobUrl
};
