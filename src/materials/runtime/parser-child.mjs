import {
  DOCUMENT_PARSER_VERSION,
  MAX_FILE_SIZE_BYTES
} from "./child-chunks/chunk-XISQIFN4.mjs";

// src/materials/vendor/parser/parser-child.ts
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

// src/materials/vendor/parser/supervisor/child-guard.ts
import { createRequire, syncBuiltinESMExports } from "node:module";
function installParserCapabilityGuard() {
  const require2 = createRequire(import.meta.url);
  const deny = () => {
    throw new Error("PARSER_CAPABILITY_DENIED");
  };
  const replace = (object, name, constructor = false) => {
    if (typeof object[name] === "function") object[name] = constructor ? new Proxy(object[name], { construct: deny, apply: deny }) : deny;
  };
  replace(globalThis, "fetch");
  for (const name of ["WebSocket", "EventSource", "Worker"]) replace(globalThis, name, true);
  for (const name of ["http", "https"]) {
    const api = require2(`node:${name}`);
    for (const method of ["request", "get", "createServer"]) replace(api, method);
    replace(api.Agent.prototype, "createConnection");
  }
  const http2 = require2("node:http2");
  for (const name of ["connect", "createServer", "createSecureServer"]) replace(http2, name);
  const net = require2("node:net");
  for (const name of ["connect", "createConnection", "createServer"]) replace(net, name);
  replace(net.Socket.prototype, "connect");
  replace(net.Server.prototype, "listen");
  const tls = require2("node:tls");
  for (const name of ["connect", "createServer"]) replace(tls, name);
  const dgram = require2("node:dgram");
  replace(dgram, "createSocket");
  for (const name of ["connect", "send", "bind"]) replace(dgram.Socket.prototype, name);
  const dns = require2("node:dns");
  for (const object of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const name of Object.getOwnPropertyNames(object)) if (/^(?:lookup|resolve|reverse)/u.test(name)) replace(object, name);
  }
  const child = require2("node:child_process");
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) replace(child, name);
  replace(child.ChildProcess.prototype, "spawn");
  replace(require2("node:worker_threads"), "Worker", true);
  replace(process, "execve");
  syncBuiltinESMExports();
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
function validateChildRequest(value) {
  if (!exactKeys(value, ["schemaVersion", "taskId", "generation", "inputPath", "documentKind", "parserVersion"]) || value.schemaVersion !== CHILD_SCHEMA_VERSION || !isTaskIdentity(value.taskId, value.generation) || typeof value.inputPath !== "string" || value.inputPath.length === 0 || value.inputPath.length > 4096 || !["pdf", "docx", "image"].includes(value.documentKind) || value.parserVersion !== DOCUMENT_PARSER_VERSION) throw new Error("PARSER_INVALID_REQUEST");
}

// src/materials/vendor/parser/parser-child.ts
installParserCapabilityGuard();
console.log = console.info = console.debug = () => {
};
var requestBytes = 0;
var chunks = [];
try {
  for await (const chunk of process.stdin) {
    requestBytes += Buffer.byteLength(chunk);
    if (requestBytes > CHILD_REQUEST_MAX_BYTES) throw new Error("PARSER_INVALID_REQUEST");
    chunks.push(Buffer.from(chunk));
  }
  const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  validateChildRequest(request);
  const cwd = await realpath(process.cwd());
  if (request.inputPath !== join(cwd, "input.bin")) throw new Error("PARSER_INVALID_REQUEST");
  const stat = await lstat(request.inputPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_SIZE_BYTES || await realpath(request.inputPath) !== request.inputPath) throw new Error("PARSER_INVALID_REQUEST");
  const { parseDocument } = await import("./child-chunks/parse-document-WUSQ2WXS.mjs");
  const outcome = await parseDocument(request.inputPath, request.documentKind);
  const reply = JSON.stringify({ schemaVersion: CHILD_SCHEMA_VERSION, taskId: request.taskId, generation: request.generation, outcome });
  if (Buffer.byteLength(reply) > CHILD_OUTPUT_CEILING_BYTES) throw new Error("PARSER_OUTPUT_LIMIT");
  await new Promise((resolve, reject) => process.stdout.write(`${reply}
`, (error) => error ? reject(error) : resolve()));
} catch {
  process.stderr.write("PARSER_CHILD_FAILED\n");
  process.exitCode = 64;
}
