import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DocumentParseResult, PdfBoundingBox } from '../contracts/documents.ts';
import {
  DOCUMENT_MAX_BLOCKS,
  MAX_PDF_PAGES,
  PDF_OCR_MIN_NON_WHITESPACE_CHARS,
  PDF_OCR_MIN_PAGE_CHARS,
} from '../domain/document-limits.ts';
import { AnnotationType, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { DocumentParseError, normalizeDocument, type RawPdfBlock } from './normalize.ts';
import { isFileSystemError } from './file-errors.ts';

// URI is not itself executable. Only a narrowly classified passive Link is accepted below.
// Decode PDF name escapes before this conservative guard, so /Java#53cript cannot evade it.
const ACTIVE_PDF_NAMES = new Set(['JavaScript', 'JS', 'OpenAction', 'AA', 'EmbeddedFiles', 'Filespec', 'Launch',
  'GoToR', 'GoToE', 'Named', 'SubmitForm', 'ImportData', 'ResetForm', 'Hide', 'SetOCGState',
  'Rendition', 'Sound', 'Movie', 'RichMedia', 'Next', 'ObjStm', 'Encrypt']);
const require = createRequire(import.meta.url);
const PDFJS_ROOT = resolve(dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')), '../..');
const PDFJS_CMAP_URL = `${resolve(PDFJS_ROOT, 'cmaps').replaceAll('\\', '/')}/`;
const PDFJS_STANDARD_FONT_URL = `${resolve(PDFJS_ROOT, 'standard_fonts').replaceAll('\\', '/')}/`;

export type PdfParseOutcome =
  | { status: 'PARSED'; result: DocumentParseResult }
  | { status: 'OCR_REQUIRED'; reason: 'insufficient-text' };

export async function parsePdf(path: string): Promise<PdfParseOutcome> {
  const file = await readFile(path);
  assertNoActivePdfNames(file);

  const loadingTask = getDocument({
    data: new Uint8Array(file),
    verbosity: 0,
    stopAtErrors: true,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_STANDARD_FONT_URL,
    disableStream: true,
    disableAutoFetch: true,
  });
  let document: Awaited<typeof loadingTask.promise> | undefined;
  try {
    document = await loadingTask.promise;
    if (document.numPages > MAX_PDF_PAGES) {
      throw new DocumentParseError('PDF_TOO_MANY_PAGES');
    }
    await assertSafeDocument(document);

    const blocks: RawPdfBlock[] = [];
    const pageCharacterCounts: number[] = [];
    let readingOrderReview = false, columnCandidate = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      await assertSafePage(page);
      const textContent = await page.getTextContent({ disableNormalization: false });
      const pageResult = buildPageBlocks(textContent.items, pageNumber);
      readingOrderReview ||= pageResult.readingOrderReview; columnCandidate ||= pageResult.columnCandidate;
      blocks.push(...pageResult.blocks);
      if (blocks.length > DOCUMENT_MAX_BLOCKS) throw new DocumentParseError('DOCUMENT_UNSAFE');
      pageCharacterCounts.push(nonWhitespaceLength(pageResult.blocks.map((block) => block.text).join('')));
      page.cleanup();
    }

    const totalCharacters = pageCharacterCounts.reduce((total, count) => total + count, 0);
    const textPoorPages = pageCharacterCounts.filter(
      (count) => count < PDF_OCR_MIN_PAGE_CHARS,
    ).length;
    if (
      totalCharacters < PDF_OCR_MIN_NON_WHITESPACE_CHARS ||
      (document.numPages > 1 && textPoorPages > document.numPages / 2)
    ) {
      return { status: 'OCR_REQUIRED', reason: 'insufficient-text' };
    }

    const qualityReasons = textPoorPages > 0 ? ['partial-text-layer'] : ['native-text-layer'];
    if (readingOrderReview) qualityReasons.push('reading-order-review-required',
      columnCandidate ? 'two-column-order-candidate' : 'layout-fragments-preserved');
    return {
      status: 'PARSED',
      result: normalizeDocument({
        documentKind: 'pdf',
        blocks,
        pageCount: document.numPages,
        qualityScore: readingOrderReview ? 0.8 : textPoorPages > 0 ? 0.9 : 1,
        qualityReasons,
      }),
    };
  } catch (error) {
    if (error instanceof DocumentParseError || isFileSystemError(error)) throw error;
    throw new DocumentParseError('DOCUMENT_UNSAFE');
  } finally {
    await loadingTask.destroy();
  }
}

async function assertSafeDocument(
  document: Awaited<ReturnType<typeof getDocument>['promise']>,
): Promise<void> {
  const [javaScriptActions, openAction, attachments] = await Promise.all([
    document.getJSActions(),
    document.getOpenAction(),
    document.getAttachments(),
  ]);
  if (hasActionValues(javaScriptActions) || openAction !== null || hasActionValues(attachments)) {
    throw new DocumentParseError('DOCUMENT_UNSAFE');
  }
}

async function assertSafePage(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof getDocument>['promise']>['getPage']>>,
): Promise<void> {
  const [javaScriptActions, annotations] = await Promise.all([
    page.getJSActions(),
    page.getAnnotations({ intent: 'any' }),
  ]);
  if (hasActionValues(javaScriptActions)) throw new DocumentParseError('DOCUMENT_UNSAFE');
  for (const annotation of annotations as Array<Record<string, unknown>>) {
    if (classifyAnnotation(annotation) === 'unsafe') throw new DocumentParseError('DOCUMENT_UNSAFE');
  }
}

function assertNoActivePdfNames(bytes: Buffer): void {
  for (const match of bytes.toString('latin1').matchAll(/\/([^\s\x00()[\]<>/%{}]+)/gu)) {
    const name = match[1]!.replace(/#([a-f0-9]{2})/giu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (ACTIVE_PDF_NAMES.has(name)) throw new DocumentParseError('DOCUMENT_UNSAFE');
  }
}

function safePassiveUri(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 8192 || value.trim() !== value || /[\u0000-\u0020\u007f\\]/u.test(value)) return false;
  try {
    const target = new URL(value);
    return (target.protocol === 'http:' || target.protocol === 'https:') ? !!target.hostname && !target.username && !target.password
      : target.protocol === 'mailto:' && !!target.pathname && !target.hash;
  } catch { return false; }
}

/** No link target is returned or visited. Only the already extracted visible page text is retained. */
function classifyAnnotation(annotation: Record<string, unknown>): 'passive-link' | 'inert' | 'unsafe' {
  if (annotation.annotationType === AnnotationType.FILEATTACHMENT || annotation.file !== undefined
    || annotation.action !== undefined || annotation.dest !== undefined || annotation.hasJSActions === true
    || hasActionValues(annotation.jsActions) || annotation.resetForm !== undefined || annotation.setOCGState !== undefined
    || annotation.submitForm !== undefined || annotation.attachment !== undefined || hasActionValues(annotation.actions)) return 'unsafe';
  if (annotation.annotationType === AnnotationType.LINK) {
    // Validate the unfiltered original URL too: pdf.js deliberately drops unsafe schemes from .url.
    return safePassiveUri(annotation.unsafeUrl) && safePassiveUri(annotation.url) ? 'passive-link' : 'unsafe';
  }
  return annotation.url !== undefined || annotation.unsafeUrl !== undefined ? 'unsafe' : 'inert';
}

function buildPageBlocks(items: unknown[], pageNumber: number): { blocks: RawPdfBlock[]; readingOrderReview: boolean; columnCandidate: boolean } {
  const positioned = items
    .filter(isTextItem)
    .filter((item) => item.str.trim().length > 0)
    .map((item) => ({
      text: item.str,
      x: finiteCoordinate(item.transform[4]),
      y: finiteCoordinate(item.transform[5]),
      width: Math.max(0, finiteCoordinate(item.width)),
      height: Math.max(0, finiteCoordinate(item.height)),
      hasEOL: item.hasEOL,
    }))
    .sort((left, right) => right.y - left.y || left.x - right.x);
  if (positioned.length > 100_000) throw new DocumentParseError('DOCUMENT_UNSAFE');

  const lines: PositionedText[][] = [];
  for (const item of positioned) {
    const line = lines.at(-1);
    if (line && Math.abs((line[0]?.y ?? 0) - item.y) <= 2.5) line.push(item);
    else lines.push([item]);
  }

  let wideGutter = false;
  const fragments = lines.flatMap(line => {
    const ordered = line.sort((left, right) => left.x - right.x), groups: PositionedText[][] = [[]];
    for (const item of ordered) {
      const previous = groups.at(-1)!.at(-1);
      if (previous && item.x - previous.x - previous.width > Math.max(54, previous.height * 4, item.height * 4)) {
        wideGutter = true; groups.push([]);
      }
      groups.at(-1)!.push(item);
    }
    return groups.filter(group => group.length > 0);
  });
  // A finite two-column candidate: repeated nonoverlapping left/right fragments with a wide gutter.
  // Full-width spanners are kept as header/footer only when wholly outside both column bodies.
  const starts = [...new Set(fragments.map(fragment => fragment[0]!.x))].sort((a, b) => a - b);
  let gap = 0, rightStart = 0;
  for (let index = 1; index < starts.length; index++) {
    const candidate = starts[index]! - starts[index - 1]!;
    if (candidate > gap) { gap = candidate; rightStart = starts[index]!; }
  }
  let orderedFragments = fragments, columnCandidate = false;
  if (gap >= 72) {
    const left = fragments.filter(fragment => fragment[0]!.x < rightStart && fragment.every(item => item.x + item.width <= rightStart - 24));
    const right = fragments.filter(fragment => fragment.every(item => item.x >= rightStart));
    if (left.length >= 2 && right.length >= 2) {
      columnCandidate = true;
      const body = new Set([...left, ...right]), spanners = fragments.filter(fragment => !body.has(fragment));
      const top = Math.max(...[...left, ...right].map(fragment => fragment[0]!.y));
      const bottom = Math.min(...[...left, ...right].map(fragment => fragment[0]!.y));
      const header = spanners.filter(fragment => fragment[0]!.y > top + 2.5), footer = spanners.filter(fragment => fragment[0]!.y < bottom - 2.5);
      // Ambiguous middle spanners stay in the original positioned fragment order for explicit review.
      if (header.length + footer.length === spanners.length) orderedFragments = [...header, ...left, ...right, ...footer];
    }
  }
  const blocks = orderedFragments
    .map((line) => ({
      kind: 'pdf' as const,
      pageNumber,
      text: joinLine(line),
      bbox: lineBoundingBox(line),
    }))
    .filter((block) => block.text.trim().length > 0);
  return { blocks, readingOrderReview: wideGutter || columnCandidate, columnCandidate };
}

interface PositionedText {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hasEOL: boolean;
}

function joinLine(line: PositionedText[]): string {
  let text = '';
  let previous: PositionedText | undefined;
  for (const item of line) {
    if (previous && shouldInsertSpace(previous, item, text)) text += ' ';
    text += item.text;
    previous = item;
  }
  return text.trim();
}

function shouldInsertSpace(
  previous: PositionedText,
  current: PositionedText,
  text: string,
): boolean {
  if (/\s$/u.test(text) || /^\s/u.test(current.text)) return false;
  const gap = current.x - (previous.x + previous.width);
  return previous.hasEOL || gap > 0.5;
}

function lineBoundingBox(line: PositionedText[]): PdfBoundingBox {
  const minX = Math.min(...line.map((item) => item.x));
  const minY = Math.min(...line.map((item) => item.y));
  const maxX = Math.max(...line.map((item) => item.x + item.width));
  const maxY = Math.max(...line.map((item) => item.y + item.height));
  return {
    x: roundCoordinate(minX),
    y: roundCoordinate(minY),
    width: roundCoordinate(Math.max(0, maxX - minX)),
    height: roundCoordinate(Math.max(0, maxY - minY)),
  };
}

function isTextItem(value: unknown): value is TextItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    'str' in value &&
    typeof value.str === 'string' &&
    'transform' in value &&
    Array.isArray(value.transform)
  );
}

interface TextItem {
  str: string;
  transform: unknown[];
  width: number;
  height: number;
  hasEOL: boolean;
}

function hasActionValues(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  return Object.values(value).some((item) =>
    Array.isArray(item) ? item.length > 0 : item !== undefined && item !== null,
  );
}

function nonWhitespaceLength(value: string): number {
  return value.replace(/\s/gu, '').length;
}

function finiteCoordinate(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
