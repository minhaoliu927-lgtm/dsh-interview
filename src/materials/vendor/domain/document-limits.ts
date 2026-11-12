/** Extracted from legacy resume.ts; parser-local limits only, no billing or service rules. */
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_PAGES = 50;
export const DOCX_MAX_UNCOMPRESSED_SIZE_BYTES = 50 * 1024 * 1024;
export const DOCX_MAX_ENTRY_SIZE_BYTES = 20 * 1024 * 1024;
export const DOCX_MAX_ENTRIES = 2_000;
export const DOCUMENT_MIN_TEXT_LENGTH = 1;
export const DOCUMENT_MAX_TEXT_LENGTH = 200_000;
export const DOCUMENT_MAX_BLOCKS = 20_000;
export const PDF_OCR_MIN_NON_WHITESPACE_CHARS = 80;
export const PDF_OCR_MIN_PAGE_CHARS = 20;
// These are declarations for G12 supervision, not guarantees of an in-process parser.
export const DOCUMENT_PARSE_TIMEOUT_MS = 30_000;
export const DOCUMENT_PARSE_MEMORY_MB = 256;
export const DOCUMENT_SCHEMA_VERSION = 'document-parse/v1' as const;
export const DOCUMENT_PARSER_NAME = 'native-document-parser' as const;
export const DOCUMENT_PARSER_VERSION = 'native-v1-g11.1' as const;
