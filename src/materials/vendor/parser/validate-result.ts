import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { DocumentParseResultSchema, type DocumentParseResult } from '../contracts/documents.ts';
import { DOCUMENT_MAX_TEXT_LENGTH } from '../domain/document-limits.ts';

function invalid(): never { throw new Error('DOCUMENT_RESULT_INVALID'); }
function wellFormed(text: string): boolean {
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return false;
  }
  return true;
}
function boundary(text: string, position: number): boolean {
  const previous = text.charCodeAt(position - 1), next = text.charCodeAt(position);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}
/** Shape and independent business validation; errors never contain text or file paths. */
export function validateDocumentParseResult(value: unknown): asserts value is DocumentParseResult {
  if (!Value.Check(DocumentParseResultSchema, value)) invalid();
  const result = value as DocumentParseResult, text = result.plainText;
  if (!wellFormed(text) || text.includes('\r') || text.length > DOCUMENT_MAX_TEXT_LENGTH) invalid();
  if (createHash('sha256').update(text, 'utf8').digest('hex') !== result.contentHash) invalid();
  const reviewRequired = result.qualityReasons.some(reason => reason === 'reading-order-review-required' || reason === 'unsupported-structure-review-required');
  if ((reviewRequired && result.requiresConfirmation !== true) || (result.requiresConfirmation === true && result.qualityScore > 0.8)) invalid();
  if (result.documentKind === 'docx' ? result.pageCount !== null : !Number.isSafeInteger(result.pageCount)) invalid();
  let previousEnd = 0, previousPage = 0;
  for (const [index, block] of result.blocks.entries()) {
    if (block.kind !== result.documentKind || block.blockIndex !== index || !Number.isSafeInteger(block.blockIndex)) invalid();
    const { startOffset: start, endOffset: end } = block;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length
      || start !== (index === 0 ? 0 : previousEnd + 1) || !boundary(text, start) || !boundary(text, end)
      || !wellFormed(block.text) || text.slice(start, end) !== block.text) invalid();
    if (block.kind === 'pdf') {
      if (!Number.isSafeInteger(block.pageNumber) || block.pageNumber < 1 || block.pageNumber > result.pageCount!
        || block.pageNumber < previousPage) invalid();
      previousPage = block.pageNumber;
      if (block.bbox && (!Object.values(block.bbox).every(Number.isFinite) || block.bbox.width < 0 || block.bbox.height < 0)) invalid();
    } else {
      const location = /^(document|word\/(?:header|footer)[1-9]\d*\.xml)\/((?:table\[[1-9]\d*\]\/row\[[1-9]\d*\]\/cell\[[1-9]\d*\]\/){0,8}paragraph\[[1-9]\d*\])$/u.exec(block.path);
      if (!location || (location[1] === 'document'
        ? block.sourcePart !== undefined && block.sourcePart !== 'word/document.xml'
        : block.sourcePart !== location[1])) invalid();
    }
    previousEnd = end;
  }
  if (previousEnd !== text.length || result.blocks.map(block => block.text).join('\n') !== text) invalid();
}
export function freezeDocumentResult(result: DocumentParseResult): DocumentParseResult {
  validateDocumentParseResult(result);
  for (const block of result.blocks) { if (block.kind === 'pdf' && block.bbox) Object.freeze(block.bbox); Object.freeze(block); }
  Object.freeze(result.blocks); Object.freeze(result.qualityReasons); return Object.freeze(result);
}
