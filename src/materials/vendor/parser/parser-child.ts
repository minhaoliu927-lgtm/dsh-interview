import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { installParserCapabilityGuard } from './supervisor/child-guard.ts';
import { CHILD_OUTPUT_CEILING_BYTES, CHILD_REQUEST_MAX_BYTES, CHILD_SCHEMA_VERSION, validateChildRequest } from './supervisor/protocol.ts';
import { MAX_FILE_SIZE_BYTES } from '../domain/document-limits.ts';

installParserCapabilityGuard();
// Stdout is a protocol channel. Third-party diagnostics must not corrupt it.
console.log = console.info = console.debug = () => {};
let requestBytes = 0;
const chunks: Buffer[] = [];
try {
  for await (const chunk of process.stdin) {
    requestBytes += Buffer.byteLength(chunk);
    if (requestBytes > CHILD_REQUEST_MAX_BYTES) throw new Error('PARSER_INVALID_REQUEST');
    chunks.push(Buffer.from(chunk));
  }
  const request: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  validateChildRequest(request);
  const cwd = await realpath(process.cwd());
  if (request.inputPath !== join(cwd, 'input.bin')) throw new Error('PARSER_INVALID_REQUEST');
  const stat = await lstat(request.inputPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_SIZE_BYTES || await realpath(request.inputPath) !== request.inputPath) throw new Error('PARSER_INVALID_REQUEST');
  // This is the only production import of the expensive native parser in this task path.
  const { parseDocument } = await import('./parse-document.ts');
  const outcome = await parseDocument(request.inputPath, request.documentKind);
  const reply = JSON.stringify({ schemaVersion: CHILD_SCHEMA_VERSION, taskId: request.taskId, generation: request.generation, outcome });
  if (Buffer.byteLength(reply) > CHILD_OUTPUT_CEILING_BYTES) throw new Error('PARSER_OUTPUT_LIMIT');
  await new Promise<void>((resolve, reject) => process.stdout.write(`${reply}\n`, error => error ? reject(error) : resolve()));
} catch {
  process.stderr.write('PARSER_CHILD_FAILED\n');
  process.exitCode = 64;
}
