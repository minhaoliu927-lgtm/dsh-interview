import { Type, type Static } from '@sinclair/typebox';
import { DOCUMENT_MAX_BLOCKS, DOCUMENT_MAX_TEXT_LENGTH, MAX_PDF_PAGES } from '../domain/document-limits.ts';
const Sha256Schema = Type.String({ pattern: '^[a-f0-9]{64}$' });

export const DocumentKindSchema = Type.Union([Type.Literal('pdf'), Type.Literal('docx')]);
export type DocumentKind = Static<typeof DocumentKindSchema>;

export const PdfBoundingBoxSchema = Type.Object(
  {
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Number({ minimum: 0 }),
    height: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type PdfBoundingBox = Static<typeof PdfBoundingBoxSchema>;

export const PdfDocumentBlockSchema = Type.Object(
  {
    kind: Type.Literal('pdf'),
    pageNumber: Type.Integer({ minimum: 1, maximum: MAX_PDF_PAGES }),
    blockIndex: Type.Integer({ minimum: 0 }),
    startOffset: Type.Integer({ minimum: 0 }),
    endOffset: Type.Integer({ minimum: 1 }),
    text: Type.String({ minLength: 1, maxLength: DOCUMENT_MAX_TEXT_LENGTH }),
    bbox: Type.Optional(PdfBoundingBoxSchema),
  },
  { additionalProperties: false },
);
export type PdfDocumentBlock = Static<typeof PdfDocumentBlockSchema>;

export const DocxBlockTypeSchema = Type.Union([
  Type.Literal('paragraph'),
  Type.Literal('listItem'),
  Type.Literal('tableCell'),
]);
export type DocxBlockType = Static<typeof DocxBlockTypeSchema>;

export const DocxDocumentBlockSchema = Type.Object(
  {
    kind: Type.Literal('docx'),
    blockIndex: Type.Integer({ minimum: 0 }),
    blockType: DocxBlockTypeSchema,
    path: Type.String({ minLength: 1, maxLength: 500 }),
    sourcePart: Type.Optional(Type.String({ maxLength: 64, pattern: '^word/(?:document|(?:header|footer)(?:[1-9]|[12][0-9]|3[0-2]))\\.xml$' })),
    startOffset: Type.Integer({ minimum: 0 }),
    endOffset: Type.Integer({ minimum: 1 }),
    text: Type.String({ minLength: 1, maxLength: DOCUMENT_MAX_TEXT_LENGTH }),
  },
  { additionalProperties: false },
);
export type DocxDocumentBlock = Static<typeof DocxDocumentBlockSchema>;

export const DocumentBlockSchema = Type.Union([PdfDocumentBlockSchema, DocxDocumentBlockSchema]);
export type DocumentBlock = Static<typeof DocumentBlockSchema>;

export const DocumentParseResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal('document-parse/v1'),
    documentKind: DocumentKindSchema,
    plainText: Type.String({ minLength: 1, maxLength: DOCUMENT_MAX_TEXT_LENGTH }),
    contentHash: Sha256Schema,
    blocks: Type.Array(DocumentBlockSchema, { minItems: 1, maxItems: DOCUMENT_MAX_BLOCKS }),
    pageCount: Type.Union([Type.Integer({ minimum: 1, maximum: MAX_PDF_PAGES }), Type.Null()]),
    parserName: Type.String({ minLength: 1, maxLength: 100 }),
    parserVersion: Type.String({ minLength: 1, maxLength: 100 }),
    qualityScore: Type.Number({ minimum: 0, maximum: 1 }),
    qualityReasons: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: 100,
    }),
    requiresConfirmation: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type DocumentParseResult = Static<typeof DocumentParseResultSchema>;

export const DOCUMENT_FAILURE_CODES = ['FILE_TYPE_MISMATCH', 'DOCUMENT_READ_FAILED', 'DOCUMENT_TOO_LARGE', 'DOCUMENT_UNSAFE', 'PDF_TOO_MANY_PAGES', 'DOCX_ARCHIVE_LIMIT', 'DOCUMENT_TEXT_EMPTY', 'DOCUMENT_RESULT_INVALID'] as const;
export type DocumentFailureCode = typeof DOCUMENT_FAILURE_CODES[number];
export type ParseDocumentKind = DocumentKind | 'image';
export const DocumentParseOutcomeSchema = Type.Union([
  Type.Object({status:Type.Literal('PARSED'),result:DocumentParseResultSchema},{additionalProperties:false}),
  Type.Object({status:Type.Literal('OCR_REQUIRED'),reason:Type.Union([Type.Literal('image'),Type.Literal('insufficient-text')])},{additionalProperties:false}),
  Type.Object({status:Type.Literal('FAILED'),code:Type.Union(DOCUMENT_FAILURE_CODES.map(code=>Type.Literal(code)))},{additionalProperties:false}),
]);
export type ParseDocumentOutcome = Static<typeof DocumentParseOutcomeSchema>;
