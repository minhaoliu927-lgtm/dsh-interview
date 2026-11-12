import { createHash } from 'node:crypto';
import type {
  DocumentFailureCode,
  DocumentParseResult,
  DocxBlockType,
  PdfBoundingBox,
} from '../contracts/documents.ts';
import {
  DOCUMENT_MAX_BLOCKS,
  DOCUMENT_MAX_TEXT_LENGTH,
  DOCUMENT_PARSER_NAME,
  DOCUMENT_PARSER_VERSION,
  DOCUMENT_SCHEMA_VERSION,
} from '../domain/document-limits.ts';

export type DocumentParseErrorCode = DocumentFailureCode;

export class DocumentParseError extends Error {
  constructor(readonly code: DocumentParseErrorCode) {
    super(code);
    this.name = 'DocumentParseError';
  }
}

export interface RawPdfBlock {
  kind: 'pdf';
  pageNumber: number;
  text: string;
  bbox?: PdfBoundingBox;
}

export interface RawDocxBlock {
  kind: 'docx';
  blockType: DocxBlockType;
  path: string;
  sourcePart?: string;
  text: string;
}

export type RawDocumentBlock = RawPdfBlock | RawDocxBlock;

export interface NormalizeDocumentInput {
  documentKind: 'pdf' | 'docx';
  blocks: RawDocumentBlock[];
  pageCount: number | null;
  qualityScore: number;
  qualityReasons: string[];
}

export function normalizeDocument(input: NormalizeDocumentInput): DocumentParseResult {
  const normalizedBlocks = input.blocks
    .map((block) => ({ ...block, text: normalizeBlockText(block.text) }))
    .filter((block) => block.text.length > 0);

  if (normalizedBlocks.length === 0) throw new DocumentParseError('DOCUMENT_TEXT_EMPTY');
  if (normalizedBlocks.length > DOCUMENT_MAX_BLOCKS) throw new DocumentParseError('DOCUMENT_UNSAFE');

  let plainText = '';
  const blocks: DocumentParseResult['blocks'] = [];
  for (const [blockIndex, block] of normalizedBlocks.entries()) {
    if (plainText.length > 0) plainText += '\n';
    const startOffset = plainText.length;
    plainText += block.text;
    const endOffset = plainText.length;
    if (endOffset > DOCUMENT_MAX_TEXT_LENGTH) throw new DocumentParseError('DOCUMENT_UNSAFE');

    if (block.kind === 'pdf') {
      blocks.push({
        kind: 'pdf',
        pageNumber: block.pageNumber,
        blockIndex,
        startOffset,
        endOffset,
        text: block.text,
        ...(block.bbox ? { bbox: block.bbox } : {}),
      });
    } else {
      blocks.push({
        kind: 'docx',
        blockIndex,
        blockType: block.blockType,
        path: block.path,
        ...(block.sourcePart ? { sourcePart: block.sourcePart } : {}),
        startOffset,
        endOffset,
        text: block.text,
      });
    }
  }

  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    documentKind: input.documentKind,
    plainText,
    contentHash: createHash('sha256').update(plainText, 'utf8').digest('hex'),
    blocks,
    pageCount: input.pageCount,
    parserName: DOCUMENT_PARSER_NAME,
    parserVersion: DOCUMENT_PARSER_VERSION,
    qualityScore: clampQuality(input.qualityScore),
    qualityReasons: [...new Set(input.qualityReasons)].slice(0, 100),
    ...(input.qualityReasons.some(reason => reason === 'reading-order-review-required' || reason === 'unsupported-structure-review-required')
      ? { requiresConfirmation: true } : {}),
  };
}

function normalizeBlockText(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n');
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint < 32 && ![9, 10].includes(codePoint)) || codePoint === 127) {
      throw new DocumentParseError('DOCUMENT_UNSAFE');
    }
  }
  return normalized.trim();
}

function clampQuality(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
