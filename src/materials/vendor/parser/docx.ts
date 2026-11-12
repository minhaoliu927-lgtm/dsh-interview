import type { DocumentParseResult, DocxBlockType } from '../contracts/documents.ts';
import {
  DOCUMENT_MAX_BLOCKS,
  DOCUMENT_MAX_TEXT_LENGTH,
  DOCX_MAX_ENTRIES,
  DOCX_MAX_ENTRY_SIZE_BYTES,
  DOCX_MAX_UNCOMPRESSED_SIZE_BYTES,
} from '../domain/document-limits.ts';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { openPromise, type Entry } from 'yauzl';
import { DocumentParseError, normalizeDocument, type RawDocxBlock } from './normalize.ts';
import { isFileSystemError } from './file-errors.ts';

const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DOCUMENT_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const REQUIRED_ENTRIES = new Set(['[Content_Types].xml', 'word/document.xml']);
const XML_ENTRIES = new Set(['[Content_Types].xml', 'word/document.xml']);
const MAX_COMPRESSION_RATIO = 100;
const COMPRESSION_RATIO_MIN_BYTES = 1024 * 1024;
const MAX_TABLE_DEPTH = 8;
// Finite support, not an arbitrary OOXML part loader. Relationships never trigger I/O.
const AUXILIARY_PART = /^word\/(header|footer)([1-9]|[12]\d|3[0-2])\.xml$/u;
const AUXILIARY_RELATIONSHIPS = /^word\/_rels\/(header|footer)([1-9]|[12]\d|3[0-2])\.xml\.rels$/u;
const REVIEW_REASON = 'unsupported-structure-review-required';

interface Relationship {
  type: string;
  target: string;
  external: boolean;
}
type Relationships = Map<string, Relationship>;
interface PartReference { part: string; kind: 'header' | 'footer' }

export async function parseDocx(path: string): Promise<DocumentParseResult> {
  let entryNames: Set<string>;
  try {
    entryNames = await inspectArchive(path);
  } catch (error) {
    if (error instanceof DocumentParseError || isFileSystemError(error)) throw error;
    throw new DocumentParseError('DOCUMENT_UNSAFE');
  }

  for (const required of REQUIRED_ENTRIES) {
    if (!entryNames.has(required)) throw new DocumentParseError('DOCUMENT_UNSAFE');
  }

  let xmlParts: Map<string, Buffer>;
  try {
    xmlParts = await readXmlParts(path);
  } catch (error) {
    if (error instanceof DocumentParseError || isFileSystemError(error)) throw error;
    throw new DocumentParseError('DOCUMENT_UNSAFE');
  }

  const contentTypes = inspectContentTypes(decodeXml(requiredPart(xmlParts, '[Content_Types].xml')));
  for (const name of entryNames) {
    const auxiliary = AUXILIARY_PART.exec(name);
    if (auxiliary && contentTypes.get(`/${name}`) !== `application/vnd.openxmlformats-officedocument.wordprocessingml.${auxiliary[1]}+xml`) {
      throw new DocumentParseError('DOCUMENT_UNSAFE');
    }
  }
  const relationshipsByOwner = new Map<string, Relationships>();
  for (const [name, content] of xmlParts) {
    if (!name.endsWith('.rels')) continue;
    const owner = relationshipOwner(name);
    if (owner && !entryNames.has(owner)) throw new DocumentParseError('DOCUMENT_UNSAFE');
    relationshipsByOwner.set(owner, inspectRelationships(decodeXml(content), owner, entryNames));
  }
  const main = extractDocumentBlocks(
    decodeXml(requiredPart(xmlParts, 'word/document.xml')),
    'word/document.xml',
    relationshipsByOwner.get('word/document.xml') ?? new Map(),
  );
  const blocks = [...main.blocks];
  const qualityReasons = new Set(['native-ooxml-structure', ...main.qualityReasons]);
  const referencedParts = new Set<string>();
  // Append each referenced header/footer once, in first document-reference order.
  // Never fabricate page numbers or weave repeated page furniture into body paragraphs.
  for (const reference of main.references) {
    if (referencedParts.has(reference.part)) continue;
    referencedParts.add(reference.part);
    const parsed = extractDocumentBlocks(
      decodeXml(requiredPart(xmlParts, reference.part)),
      reference.part,
      relationshipsByOwner.get(reference.part) ?? new Map(),
    );
    blocks.push(...parsed.blocks);
    for (const reason of parsed.qualityReasons) qualityReasons.add(reason);
  }
  // Unreferenced parts are not body evidence; still reject malformed/active XML in them.
  for (const [name, content] of xmlParts) {
    if (AUXILIARY_PART.test(name) && !referencedParts.has(name)) {
      extractDocumentBlocks(decodeXml(content), name, relationshipsByOwner.get(name) ?? new Map());
      qualityReasons.add('unreferenced-header-footer-not-imported');
    }
  }
  if (referencedParts.size > 0) qualityReasons.add('header-footer-appended-once');
  const review = qualityReasons.has(REVIEW_REASON);
  return normalizeDocument({
    documentKind: 'docx',
    blocks,
    pageCount: null,
    qualityScore: review ? 0.8 : qualityReasons.has('merged-table-source-cell-order') ? 0.95 : 1,
    qualityReasons: [...qualityReasons],
  });
}

async function inspectArchive(path: string): Promise<Set<string>> {
  const zip = await openPromise(path, {
    lazyEntries: true,
    autoClose: true,
    validateEntrySizes: true,
    strictFileNames: true,
  });
  const names = new Set<string>();
  let totalUncompressedSize = 0;
  let count = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      count += 1;
      totalUncompressedSize += entry.uncompressedSize;
      if (
        count > DOCX_MAX_ENTRIES ||
        entry.uncompressedSize > DOCX_MAX_ENTRY_SIZE_BYTES ||
        totalUncompressedSize > DOCX_MAX_UNCOMPRESSED_SIZE_BYTES ||
        hasAbnormalCompressionRatio(entry)
      ) {
        throw new DocumentParseError('DOCX_ARCHIVE_LIMIT');
      }
      if (
        entry.isEncrypted() ||
        !entry.canDecodeFileData() ||
        ![0, 8].includes(entry.compressionMethod) ||
        isUnsafeEntryName(entry.fileName) ||
        !isAllowedEntry(entry.fileName) ||
        names.has(entry.fileName)
      ) {
        throw new DocumentParseError('DOCUMENT_UNSAFE');
      }
      names.add(entry.fileName);
    }
  } finally {
    if (zip.isOpen) zip.close();
  }
  return names;
}

async function readXmlParts(path: string): Promise<Map<string, Buffer>> {
  const zip = await openPromise(path, {
    lazyEntries: true,
    autoClose: true,
    validateEntrySizes: true,
    strictFileNames: true,
  });
  const parts = new Map<string, Buffer>();
  try {
    for await (const entry of zip.eachEntry()) {
      if (!XML_ENTRIES.has(entry.fileName) && !AUXILIARY_PART.test(entry.fileName) && !entry.fileName.endsWith('.rels')) continue;
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buffer.length;
        if (size > DOCX_MAX_ENTRY_SIZE_BYTES) {
          throw new DocumentParseError('DOCX_ARCHIVE_LIMIT');
        }
        chunks.push(buffer);
      }
      parts.set(entry.fileName, Buffer.concat(chunks));
    }
  } finally {
    if (zip.isOpen) zip.close();
  }
  return parts;
}

function inspectContentTypes(xml: string): Map<string, string> {
  assertSafeXmlPreamble(xml);
  const overrides = new Map<string, string>();
  let root = false;
  const parser = strictParser();
  parser.on('opentag', (tag) => {
    if (!root) {
      root = true;
      if (tag.uri !== CONTENT_TYPES_NAMESPACE || tag.local !== 'Types') unsafe();
      return;
    }
    if (tag.uri !== CONTENT_TYPES_NAMESPACE || !['Override', 'Default'].includes(tag.local)) unsafe();
    const contentType = attributeValue(tag, 'ContentType') ?? '';
    const partName = attributeValue(tag, 'PartName') ?? '';
    if (/macroEnabled|vbaProject|oleObject/i.test(contentType)) unsafe();
    if (tag.local === 'Override') {
      if (!partName.startsWith('/') || overrides.has(partName)) unsafe();
      overrides.set(partName, contentType);
    }
  });
  parseXml(parser, xml);
  if (overrides.get('/word/document.xml') !== DOCUMENT_CONTENT_TYPE) unsafe();
  return overrides;
}

function relationshipOwner(name: string): string {
  if (name === '_rels/.rels') return '';
  const match = /^word\/_rels\/([^/]+)\.rels$/u.exec(name);
  if (!match) unsafe();
  return `word/${match[1]}`;
}

function inspectRelationships(xml: string, owner: string, entries: Set<string>): Relationships {
  assertSafeXmlPreamble(xml);
  const relationships: Relationships = new Map();
  let depth = 0;
  const parser = strictParser();
  parser.on('opentag', (tag) => {
    depth += 1;
    if (depth === 1) {
      if (tag.uri !== RELATIONSHIPS_NAMESPACE || tag.local !== 'Relationships') unsafe();
      return;
    }
    if (depth !== 2 || tag.uri !== RELATIONSHIPS_NAMESPACE || tag.local !== 'Relationship') unsafe();
    const id = attributeValue(tag, 'Id') ?? '';
    const type = attributeValue(tag, 'Type') ?? '';
    const rawTarget = attributeValue(tag, 'Target') ?? '';
    const mode = (attributeValue(tag, 'TargetMode') ?? '').trim().toLowerCase();
    if (!id || id.length > 200 || relationships.has(id) || !rawTarget || !['', 'internal', 'external'].includes(mode)) unsafe();
    if (type === `${OFFICE_RELATIONSHIPS_NAMESPACE}/hyperlink`) {
      if (owner !== 'word/document.xml' && !AUXILIARY_PART.test(owner)) unsafe();
      if (mode === 'external') {
        if (!isPassiveTarget(rawTarget)) unsafe();
        relationships.set(id, { type, target: rawTarget, external: true });
      } else {
        // OOXML normally uses w:anchor; this limited fragment form is also local-only.
        if (!/^#[^\s#\\\x00-\x1f\x7f]{1,200}$/u.test(rawTarget)) unsafe();
        relationships.set(id, { type, target: rawTarget, external: false });
      }
      return;
    }
    if (mode === 'external') unsafe();
    const target = resolvePart(owner, rawTarget);
    if (!entries.has(target) || !isAllowedRelationship(type, owner, target)) unsafe();
    relationships.set(id, { type, target, external: false });
  });
  parser.on('closetag', () => { depth -= 1; });
  parseXml(parser, xml);
  return relationships;
}

function isAllowedRelationship(type: string, owner: string, target: string): boolean {
  if (owner === '') {
    return (type === `${OFFICE_RELATIONSHIPS_NAMESPACE}/officeDocument` && target === 'word/document.xml')
      || (type === `${RELATIONSHIPS_NAMESPACE}/metadata/core-properties` && target === 'docProps/core.xml')
      || (type === `${OFFICE_RELATIONSHIPS_NAMESPACE}/extended-properties` && target === 'docProps/app.xml');
  }
  const kind = type.startsWith(`${OFFICE_RELATIONSHIPS_NAMESPACE}/`) ? type.slice(OFFICE_RELATIONSHIPS_NAMESPACE.length + 1) : '';
  if (kind === 'header' || kind === 'footer') {
    return owner === 'word/document.xml' && AUXILIARY_PART.test(target) && target.startsWith(`word/${kind}`);
  }
  if (['styles', 'numbering', 'settings', 'fontTable', 'webSettings'].includes(kind)) return target === `word/${kind}.xml`;
  if (kind === 'theme') return /^word\/theme\/theme\d+\.xml$/u.test(target);
  if (kind === 'image') return /^word\/media\/[^/]+\.(?:png|jpe?g|gif|bmp|tiff?)$/iu.test(target);
  return false;
}

/** Resolve a package-relative target against its actual owning XML part, never a file/URL base. */
function resolvePart(owner: string, target: string): string {
  if (target.length > 500 || /[\\%?#\x00-\x20\x7f]/u.test(target) || /^(?:\/|[a-z][a-z0-9+.-]*:)/iu.test(target)) unsafe();
  const segments = owner.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (!segment) unsafe();
    if (segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) unsafe();
      segments.pop();
    } else segments.push(segment);
  }
  return segments.join('/');
}

function isPassiveTarget(target: string): boolean {
  if (target.length > 2048 || /[\\\x00-\x20\x7f]/u.test(target) || /%0[ad]/iu.test(target)) return false;
  try {
    const url = new URL(target);
    if (url.username || url.password) return false;
    if (url.protocol === 'http:' || url.protocol === 'https:') return /^https?:\/\//iu.test(target) && url.hostname.length > 0;
    return url.protocol === 'mailto:' && url.pathname.length > 0 && !/^mailto:\/\//iu.test(target);
  } catch { return false; }
}

interface ActiveParagraph {
  blockType: DocxBlockType;
  path: string;
  text: string;
  order: number;
}
interface TableContext {
  path: string;
  row: number;
  cell: number;
  paragraph: number;
  childTable: number;
  rowOpen: boolean;
  cellOpen: boolean;
}
interface ExtractedPart { blocks: RawDocxBlock[]; references: PartReference[]; qualityReasons: string[] }

function extractDocumentBlocks(xml: string, sourcePart: string, relationships: Relationships): ExtractedPart {
  assertSafeXmlPreamble(xml);
  const prefix = sourcePart === 'word/document.xml' ? 'document' : sourcePart;
  const expectedRoot = sourcePart === 'word/document.xml' ? 'document' : sourcePart.startsWith('word/header') ? 'hdr' : 'ftr';
  const completed: Array<{ order: number; block: RawDocxBlock }> = [];
  const paragraphs: ActiveParagraph[] = [];
  const tables: TableContext[] = [];
  const quality = new Set<string>();
  const references: PartReference[] = [];
  const ancestors: Array<{ uri: string; local: string }> = [];
  let topTable = 0, topParagraph = 0, paragraphOrder = 0, textDepth = 0, instructionDepth = 0, totalText = 0;
  let instruction = '';
  let fieldInstruction = '';
  const parser = strictParser();
  const review = (reason: string): void => { quality.add(REVIEW_REASON); quality.add(reason); };
  parser.on('opentag', (tag) => {
    if (ancestors.length === 0 && (tag.uri !== WORD_NAMESPACE || tag.local !== expectedRoot)) unsafe();
    if ((tag.prefix === 'w' && tag.uri !== WORD_NAMESPACE) || /^(?:OLEObject|object|control)$/iu.test(tag.local)) unsafe();
    if (tag.uri !== WORD_NAMESPACE) {
      if (['AlternateContent', 'Choice', 'Fallback'].includes(tag.local)) review('alternate-content-source-order');
      else review('unsupported-namespace-text-not-imported');
      ancestors.push({ uri: tag.uri, local: tag.local });
      return;
    }
    const paragraph = paragraphs.at(-1);
    const table = tables.at(-1);
    switch (tag.local) {
      case 'altChunk': case 'subDoc': case 'attachedTemplate': unsafe();
      case 'headerReference': case 'footerReference': {
        if (sourcePart !== 'word/document.xml' || !ancestors.some((node) => node.uri === WORD_NAMESPACE && node.local === 'sectPr')) unsafe();
        const id = attributeValue(tag, 'id', OFFICE_RELATIONSHIPS_NAMESPACE);
        const kind = tag.local === 'headerReference' ? 'header' : 'footer';
        const relationship = id ? relationships.get(id) : undefined;
        if (!relationship || relationship.external || relationship.type !== `${OFFICE_RELATIONSHIPS_NAMESPACE}/${kind}`) unsafe();
        references.push({ part: relationship.target, kind });
        break;
      }
      case 'hyperlink': {
        const id = attributeValue(tag, 'id', OFFICE_RELATIONSHIPS_NAMESPACE);
        const anchor = attributeValue(tag, 'anchor', WORD_NAMESPACE);
        const relationship = id ? relationships.get(id) : undefined;
        if (id ? !relationship || relationship.type !== `${OFFICE_RELATIONSHIPS_NAMESPACE}/hyperlink` : !anchor) unsafe();
        quality.add('passive-hyperlink-display-text-only');
        break;
      }
      case 'tbl': {
        if (tables.length >= MAX_TABLE_DEPTH || (table && !table.cellOpen)) unsafe();
        if (paragraph) review('nested-paragraph-source-order');
        const tablePath = table
          ? `${table.path}/row[${table.row}]/cell[${table.cell}]/table[${++table.childTable}]`
          : `${prefix}/table[${++topTable}]`;
        if (table) review('nested-table-source-cell-order');
        tables.push({ path: tablePath, row: 0, cell: 0, paragraph: 0, childTable: 0, rowOpen: false, cellOpen: false });
        quality.add('table-source-cell-order');
        break;
      }
      case 'tr':
        if (!table || table.rowOpen || table.cellOpen) unsafe();
        table.row += 1; table.cell = 0; table.rowOpen = true;
        break;
      case 'tc':
        if (!table || !table.rowOpen || table.cellOpen) unsafe();
        table.cell += 1; table.paragraph = 0; table.childTable = 0; table.cellOpen = true;
        break;
      case 'p': {
        if (table && !table.cellOpen) unsafe();
        if (paragraph) review('nested-paragraph-source-order');
        const path = table
          ? `${table.path}/row[${table.row}]/cell[${table.cell}]/paragraph[${++table.paragraph}]`
          : `${prefix}/paragraph[${++topParagraph}]`;
        paragraphs.push({ blockType: table ? 'tableCell' : 'paragraph', path, text: '', order: paragraphOrder++ });
        if (paragraphOrder > DOCUMENT_MAX_BLOCKS) unsafe();
        break;
      }
      case 'numPr': if (paragraph?.blockType === 'paragraph') paragraph.blockType = 'listItem'; break;
      case 'gridSpan': case 'vMerge': case 'hMerge': quality.add('merged-table-source-cell-order'); break;
      case 'drawing': case 'pict': case 'txbxContent': review('non-text-or-textbox-source-order'); break;
      case 'ins': case 'del': case 'moveFrom': case 'moveTo': review('tracked-changes-source-text'); break;
      case 'delText': review('tracked-deleted-text-not-imported'); break;
      case 'sym': review('symbol-font-text-not-decoded'); break;
      case 'footnoteReference': case 'endnoteReference': case 'commentReference':
        review('unsupported-reference-not-imported'); break;
      case 'fldSimple': {
        const command = attributeValue(tag, 'instr', WORD_NAMESPACE) ?? '';
        assertSafeField(command); review('field-display-text-only');
        break;
      }
      case 'fldChar': {
        const kind = attributeValue(tag, 'fldCharType', WORD_NAMESPACE);
        if (kind === 'begin' || kind === 'end') {
          assertSafeField(fieldInstruction); fieldInstruction = '';
        }
        review('field-display-text-only');
        break;
      }
      case 'instrText': instructionDepth += 1; instruction = ''; review('field-display-text-only'); break;
      case 't': textDepth += 1; break;
      case 'tab': if (paragraph) paragraph.text += '\t'; break;
      case 'br': case 'cr': if (paragraph) paragraph.text += '\n'; break;
    }
    ancestors.push({ uri: tag.uri, local: tag.local });
  });
  const collectText = (text: string): void => {
    if (instructionDepth > 0) instruction += text;
    if (textDepth > 0) {
      const paragraph = paragraphs.at(-1);
      if (!paragraph) unsafe();
      paragraph.text += text;
      totalText += text.length;
      if (totalText > DOCUMENT_MAX_TEXT_LENGTH) unsafe();
    }
  };
  parser.on('text', collectText);
  parser.on('cdata', collectText);
  parser.on('closetag', (tag) => {
    ancestors.pop();
    if (tag.uri !== WORD_NAMESPACE) return;
    const table = tables.at(-1);
    switch (tag.local) {
      case 't': textDepth -= 1; break;
      case 'instrText': assertSafeField(instruction); fieldInstruction += instruction; instructionDepth -= 1; break;
      case 'p': {
        const paragraph = paragraphs.pop();
        if (!paragraph) unsafe();
        completed.push({ order: paragraph.order, block: {
          kind: 'docx', blockType: paragraph.blockType, path: paragraph.path, text: paragraph.text,
          ...(sourcePart === 'word/document.xml' ? {} : { sourcePart }),
        } });
        break;
      }
      case 'tc': if (!table || !table.cellOpen) unsafe(); table.cellOpen = false; break;
      case 'tr': if (!table || !table.rowOpen || table.cellOpen) unsafe(); table.rowOpen = false; break;
      case 'tbl': if (!table || table.rowOpen || table.cellOpen) unsafe(); tables.pop(); break;
    }
  });
  parseXml(parser, xml);
  assertSafeField(fieldInstruction);
  return { blocks: completed.sort((left, right) => left.order - right.order).map(({ block }) => block), references, qualityReasons: [...quality] };
}

function assertSafeField(command: string): void {
  if (/\b(?:DDE(?:AUTO)?|INCLUDETEXT|INCLUDEPICTURE|DATABASE|LINK)\b/iu.test(command)) unsafe();
  const hyperlink = /\bHYPERLINK\s+(?:"([^"]+)"|(\S+))/iu.exec(command);
  if (hyperlink && !isPassiveTarget(hyperlink[1] ?? hyperlink[2] ?? '')) unsafe();
}

function unsafe(): never { throw new DocumentParseError('DOCUMENT_UNSAFE'); }

function strictParser(): SaxesParser<{ xmlns: true }> {
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => {
    throw new DocumentParseError('DOCUMENT_UNSAFE');
  });
  parser.on('processinginstruction', (instruction) => {
    if (instruction.target.toLowerCase() !== 'xml') {
      throw new DocumentParseError('DOCUMENT_UNSAFE');
    }
  });
  return parser;
}

function parseXml(parser: SaxesParser<{ xmlns: true }>, xml: string): void {
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof DocumentParseError) throw error;
    throw new DocumentParseError('DOCUMENT_UNSAFE');
  }
}

function assertSafeXmlPreamble(xml: string): void {
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml)) {
    throw new DocumentParseError('DOCUMENT_UNSAFE');
  }
}

function attributeValue(tag: SaxesTagNS, localName: string, namespace = ''): string | undefined {
  return Object.values(tag.attributes).find((attribute) => attribute.local === localName && attribute.uri === namespace)?.value;
}

function decodeXml(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    throw new DocumentParseError('DOCUMENT_UNSAFE');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/u, '');
}

function requiredPart(parts: Map<string, Buffer>, name: string): Buffer {
  const part = parts.get(name);
  if (!part) throw new DocumentParseError('DOCUMENT_UNSAFE');
  return part;
}

function hasAbnormalCompressionRatio(entry: Entry): boolean {
  return (
    entry.uncompressedSize >= COMPRESSION_RATIO_MIN_BYTES &&
    (entry.compressedSize === 0 ||
      entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO)
  );
}

function isUnsafeEntryName(name: string): boolean {
  return (
    name.startsWith('/') ||
    /^[a-z]:/iu.test(name) ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.split('/').some((segment) => segment === '..')
  );
}

function isAllowedEntry(name: string): boolean {
  if (/vbaProject|macros?|embeddings?|oleObject/i.test(name)) return false;
  return (
    name === '[Content_Types].xml' ||
    name === '_rels/.rels' ||
    /^docProps\/(?:core|app)\.xml$/u.test(name) ||
    /^word\/(?:document|styles|numbering|settings|fontTable|webSettings)\.xml$/u.test(name) ||
    AUXILIARY_PART.test(name) ||
    AUXILIARY_RELATIONSHIPS.test(name) ||
    /^word\/_rels\/(?:document|styles|numbering|settings|fontTable)\.xml\.rels$/u.test(name) ||
    /^word\/theme\/theme\d+\.xml$/u.test(name) ||
    /^word\/media\/[^/]+\.(?:png|jpe?g|gif|bmp|tiff?)$/iu.test(name) ||
    /^(?:_rels|docProps|word|word\/_rels|word\/theme|word\/media)\/$/u.test(name)
  );
}
