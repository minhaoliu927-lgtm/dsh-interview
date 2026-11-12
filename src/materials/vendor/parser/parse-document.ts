import type {
  DocumentFailureCode,
  ParseDocumentKind,
  ParseDocumentOutcome,
} from '../contracts/documents.ts';
import { parseDocx } from './docx.ts';
import { isFileSystemError } from './file-errors.ts';
import { inspectDocumentSignature, UploadInspectionError } from './inspect-upload.ts';
import { DocumentParseError } from './normalize.ts';
import { parsePdf } from './pdf.ts';
import { freezeDocumentResult } from './validate-result.ts';

export type { ParseDocumentKind, ParseDocumentOutcome } from '../contracts/documents.ts';

/** Parse only native local documents; failures expose stable codes without paths or parser details. */
export async function parseDocument(
  path: string,
  documentKind: ParseDocumentKind,
): Promise<ParseDocumentOutcome> {
  if (documentKind === 'image') return { status: 'OCR_REQUIRED', reason: 'image' };
  if (documentKind !== 'pdf' && documentKind !== 'docx') {
    return { status: 'FAILED', code: 'FILE_TYPE_MISMATCH' };
  }

  try {
    const inspection = await inspectDocumentSignature(path);
    if (inspection.documentKind !== documentKind) {
      throw new DocumentParseError('FILE_TYPE_MISMATCH');
    }
    const outcome = documentKind === 'pdf'
      ? await parsePdf(path)
      : { status: 'PARSED' as const, result: await parseDocx(path) };
    if (outcome.status === 'PARSED') {
      return { status: 'PARSED', result: freezeDocumentResult(outcome.result) };
    }
    return outcome;
  } catch (error) {
    return { status: 'FAILED', code: failureCode(error) };
  }
}

function failureCode(error: unknown): DocumentFailureCode {
  if (isFileSystemError(error)) return 'DOCUMENT_READ_FAILED';
  if (error instanceof DocumentParseError || error instanceof UploadInspectionError) return error.code;
  if (error instanceof Error && error.message === 'DOCUMENT_RESULT_INVALID') return 'DOCUMENT_RESULT_INVALID';
  return 'DOCUMENT_UNSAFE';
}

export { DocumentParseError, type DocumentParseErrorCode } from './normalize.ts';
