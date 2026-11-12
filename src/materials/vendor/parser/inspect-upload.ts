import { lstat, open } from 'node:fs/promises';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';
import type { DocumentFailureCode } from '../contracts/documents.ts';
import {
  DOCX_MAX_ENTRIES,
  DOCX_MAX_ENTRY_SIZE_BYTES,
  DOCX_MAX_UNCOMPRESSED_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
} from '../domain/document-limits.ts';
import { isFileSystemError } from './file-errors.ts';

export type DetectedUploadMime =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'image/png'
  | 'image/jpeg';

export interface UploadInspection {
  detectedMime: DetectedUploadMime;
  documentKind: 'pdf' | 'docx' | 'image';
}

export type UploadInspectionErrorCode = DocumentFailureCode;

export class UploadInspectionError extends Error {
  constructor(readonly code: UploadInspectionErrorCode) {
    super(code);
    this.name = 'UploadInspectionError';
  }
}

const PDF_SIGNATURE = Buffer.from('%PDF-');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REQUIRED_DOCX_ENTRIES = new Set(['[Content_Types].xml', 'word/document.xml']);

/** Container inspection retained from the legacy parser; this has no upload-service dependency. */
export async function inspectDocumentFile(path: string): Promise<UploadInspection> {
  const inspection = await inspectDocumentSignature(path);
  if (inspection.documentKind === 'docx') await inspectDocxContainer(path);
  return inspection;
}

/** Compatibility name for callers of the original local signature inspector. */
export const inspectUpload = inspectDocumentFile;

/** Lightweight preflight; the native DOCX parser owns detailed archive failure codes. */
export async function inspectDocumentSignature(path: string): Promise<UploadInspection> {
  try {
    return await readDocumentSignature(path);
  } catch (error) {
    if (error instanceof UploadInspectionError) throw error;
    throw new UploadInspectionError(isFileSystemError(error) ? 'DOCUMENT_READ_FAILED' : 'DOCUMENT_UNSAFE');
  }
}

async function readDocumentSignature(path: string): Promise<UploadInspection> {
  const signature = await readSignature(path, 8);
  if (signature.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
    return { detectedMime: 'application/pdf', documentKind: 'pdf' };
  }
  if (signature.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { detectedMime: 'image/png', documentKind: 'image' };
  }
  if (signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) {
    return { detectedMime: 'image/jpeg', documentKind: 'image' };
  }
  if (
    signature[0] === 0x50 &&
    signature[1] === 0x4b &&
    signature[2] === 0x03 &&
    signature[3] === 0x04
  ) {
    return {
      detectedMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      documentKind: 'docx',
    };
  }
  throw new UploadInspectionError('FILE_TYPE_MISMATCH');
}

async function readSignature(path: string, length: number): Promise<Buffer> {
  const entry = await lstat(path);
  if (!entry.isFile()) throw new UploadInspectionError('DOCUMENT_UNSAFE');
  if (entry.size > MAX_FILE_SIZE_BYTES) throw new UploadInspectionError('DOCUMENT_TOO_LARGE');
  const handle = await open(path, 'r');
  try {
    const openedFile = await handle.stat();
    if (!openedFile.isFile()) throw new UploadInspectionError('DOCUMENT_UNSAFE');
    if (openedFile.size > MAX_FILE_SIZE_BYTES) throw new UploadInspectionError('DOCUMENT_TOO_LARGE');
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

async function inspectDocxContainer(path: string): Promise<void> {
  const found = new Set<string>();
  let entries = 0;
  let uncompressedSize = 0;
  try {
    await withZip(path, (zip, resolve, reject) => {
      zip.on('entry', (entry: Entry) => {
        entries += 1;
        uncompressedSize += entry.uncompressedSize;
        if (
          entries > DOCX_MAX_ENTRIES ||
          entry.uncompressedSize > DOCX_MAX_ENTRY_SIZE_BYTES ||
          uncompressedSize > DOCX_MAX_UNCOMPRESSED_SIZE_BYTES ||
          (entry.generalPurposeBitFlag & 0x1) !== 0 ||
          isUnsafeEntryName(entry.fileName)
        ) {
          zip.close();
          reject(new UploadInspectionError('DOCUMENT_UNSAFE'));
          return;
        }
        if (REQUIRED_DOCX_ENTRIES.has(entry.fileName)) found.add(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => {
        if (found.size === REQUIRED_DOCX_ENTRIES.size) resolve();
        else reject(new UploadInspectionError('DOCUMENT_UNSAFE'));
      });
      zip.readEntry();
    });
  } catch (error) {
    if (error instanceof UploadInspectionError) throw error;
    throw new UploadInspectionError(isFileSystemError(error) ? 'DOCUMENT_READ_FAILED' : 'DOCUMENT_UNSAFE');
  }
}

function withZip(
  path: string,
  inspect: (zip: ZipFile, resolve: () => void, reject: (reason: unknown) => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    openZip(
      path,
      { lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) {
          reject(error ?? new Error('ZIP_OPEN_FAILED'));
          return;
        }
        zip.once('error', reject);
        inspect(zip, resolve, reject);
      },
    );
  });
}

function isUnsafeEntryName(name: string): boolean {
  return (
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.split('/').some((segment) => segment === '..')
  );
}
