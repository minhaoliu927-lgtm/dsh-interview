import { Value } from '@sinclair/typebox/value';
import { DocumentParseOutcomeSchema, type ParseDocumentKind, type ParseDocumentOutcome } from '../../contracts/documents.ts';
import { DOCUMENT_PARSER_VERSION } from '../../domain/document-limits.ts';
import { freezeDocumentResult } from '../validate-result.ts';

export const CHILD_SCHEMA_VERSION = 'document-child/v1' as const;
export const CHILD_REQUEST_MAX_BYTES = 8192;
export const CHILD_OUTPUT_CEILING_BYTES = 8 * 1024 * 1024;
export const TASK_ID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu;

export interface ChildRequest {
  schemaVersion: typeof CHILD_SCHEMA_VERSION;
  taskId: string;
  generation: number;
  inputPath: string;
  documentKind: ParseDocumentKind;
  parserVersion: string;
}
export interface ChildReply {
  schemaVersion: typeof CHILD_SCHEMA_VERSION;
  taskId: string;
  generation: number;
  outcome: ParseDocumentOutcome;
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function isTaskIdentity(taskId: unknown, generation: unknown): boolean {
  return typeof taskId === 'string' && TASK_ID_PATTERN.test(taskId)
    && typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0;
}
export function validateChildRequest(value: unknown): asserts value is ChildRequest {
  if (!exactKeys(value, ['schemaVersion', 'taskId', 'generation', 'inputPath', 'documentKind', 'parserVersion'])
    || value.schemaVersion !== CHILD_SCHEMA_VERSION || !isTaskIdentity(value.taskId, value.generation)
    || typeof value.inputPath !== 'string' || value.inputPath.length === 0 || value.inputPath.length > 4096
    || !['pdf', 'docx', 'image'].includes(value.documentKind as string)
    || value.parserVersion !== DOCUMENT_PARSER_VERSION) throw new Error('PARSER_INVALID_REQUEST');
}
export function decodeChildReply(bytes: Uint8Array, request: ChildRequest): ParseDocumentOutcome {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!exactKeys(value, ['schemaVersion', 'taskId', 'generation', 'outcome'])
    || value.schemaVersion !== CHILD_SCHEMA_VERSION || value.taskId !== request.taskId
    || value.generation !== request.generation || !Value.Check(DocumentParseOutcomeSchema, value.outcome)) {
    throw new Error('PARSER_INVALID_REPLY');
  }
  const outcome = value.outcome as ParseDocumentOutcome;
  if (outcome.status === 'PARSED') {
    if (outcome.result.parserVersion !== request.parserVersion || outcome.result.documentKind !== request.documentKind) throw new Error('PARSER_INVALID_REPLY');
    freezeDocumentResult(outcome.result);
  } else if (outcome.status === 'OCR_REQUIRED' && (outcome.reason === 'image') !== (request.documentKind === 'image')) {
    throw new Error('PARSER_INVALID_REPLY');
  }
  return outcome;
}
