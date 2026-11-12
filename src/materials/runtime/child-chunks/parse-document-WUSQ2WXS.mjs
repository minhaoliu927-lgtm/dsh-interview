import {
  DOCUMENT_MAX_BLOCKS,
  DOCUMENT_MAX_TEXT_LENGTH,
  DOCUMENT_PARSER_NAME,
  DOCUMENT_PARSER_VERSION,
  DOCUMENT_SCHEMA_VERSION,
  DOCX_MAX_ENTRIES,
  DOCX_MAX_ENTRY_SIZE_BYTES,
  DOCX_MAX_UNCOMPRESSED_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
  MAX_PDF_PAGES,
  PDF_OCR_MIN_NON_WHITESPACE_CHARS,
  PDF_OCR_MIN_PAGE_CHARS,
  freezeDocumentResult
} from "./chunk-XISQIFN4.mjs";

// src/materials/vendor/parser/docx.ts
import { SaxesParser } from "saxes";
import { openPromise } from "yauzl";

// src/materials/vendor/parser/normalize.ts
import { createHash } from "node:crypto";
var DocumentParseError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "DocumentParseError";
  }
  code;
};
function normalizeDocument(input) {
  const normalizedBlocks = input.blocks.map((block) => ({ ...block, text: normalizeBlockText(block.text) })).filter((block) => block.text.length > 0);
  if (normalizedBlocks.length === 0) throw new DocumentParseError("DOCUMENT_TEXT_EMPTY");
  if (normalizedBlocks.length > DOCUMENT_MAX_BLOCKS) throw new DocumentParseError("DOCUMENT_UNSAFE");
  let plainText = "";
  const blocks = [];
  for (const [blockIndex, block] of normalizedBlocks.entries()) {
    if (plainText.length > 0) plainText += "\n";
    const startOffset = plainText.length;
    plainText += block.text;
    const endOffset = plainText.length;
    if (endOffset > DOCUMENT_MAX_TEXT_LENGTH) throw new DocumentParseError("DOCUMENT_UNSAFE");
    if (block.kind === "pdf") {
      blocks.push({
        kind: "pdf",
        pageNumber: block.pageNumber,
        blockIndex,
        startOffset,
        endOffset,
        text: block.text,
        ...block.bbox ? { bbox: block.bbox } : {}
      });
    } else {
      blocks.push({
        kind: "docx",
        blockIndex,
        blockType: block.blockType,
        path: block.path,
        ...block.sourcePart ? { sourcePart: block.sourcePart } : {},
        startOffset,
        endOffset,
        text: block.text
      });
    }
  }
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    documentKind: input.documentKind,
    plainText,
    contentHash: createHash("sha256").update(plainText, "utf8").digest("hex"),
    blocks,
    pageCount: input.pageCount,
    parserName: DOCUMENT_PARSER_NAME,
    parserVersion: DOCUMENT_PARSER_VERSION,
    qualityScore: clampQuality(input.qualityScore),
    qualityReasons: [...new Set(input.qualityReasons)].slice(0, 100),
    ...input.qualityReasons.some((reason) => reason === "reading-order-review-required" || reason === "unsupported-structure-review-required") ? { requiresConfirmation: true } : {}
  };
}
function normalizeBlockText(value) {
  const normalized = value.replace(/\r\n?/g, "\n");
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 && ![9, 10].includes(codePoint) || codePoint === 127) {
      throw new DocumentParseError("DOCUMENT_UNSAFE");
    }
  }
  return normalized.trim();
}
function clampQuality(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// src/materials/vendor/parser/file-errors.ts
function isFileSystemError(error) {
  if (!(error instanceof Error)) return false;
  const details = error;
  return typeof details.code === "string" && /^E[A-Z0-9]+$/u.test(details.code) && typeof details.syscall === "string";
}

// src/materials/vendor/parser/docx.ts
var WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
var CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
var RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
var OFFICE_RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
var DOCUMENT_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
var REQUIRED_ENTRIES = /* @__PURE__ */ new Set(["[Content_Types].xml", "word/document.xml"]);
var XML_ENTRIES = /* @__PURE__ */ new Set(["[Content_Types].xml", "word/document.xml"]);
var MAX_COMPRESSION_RATIO = 100;
var COMPRESSION_RATIO_MIN_BYTES = 1024 * 1024;
var MAX_TABLE_DEPTH = 8;
var AUXILIARY_PART = /^word\/(header|footer)([1-9]|[12]\d|3[0-2])\.xml$/u;
var AUXILIARY_RELATIONSHIPS = /^word\/_rels\/(header|footer)([1-9]|[12]\d|3[0-2])\.xml\.rels$/u;
var REVIEW_REASON = "unsupported-structure-review-required";
async function parseDocx(path) {
  let entryNames;
  try {
    entryNames = await inspectArchive(path);
  } catch (error) {
    if (error instanceof DocumentParseError || isFileSystemError(error)) throw error;
    throw new DocumentParseError("DOCUMENT_UNSAFE");
  }
  for (const required of REQUIRED_ENTRIES) {
    if (!entryNames.has(required)) throw new DocumentParseError("DOCUMENT_UNSAFE");
  }
  let xmlParts;
  try {
    xmlParts = await readXmlParts(path);
  } catch (error) {
    if (error instanceof DocumentParseError || isFileSystemError(error)) throw error;
    throw new DocumentParseError("DOCUMENT_UNSAFE");
  }
  const contentTypes = inspectContentTypes(decodeXml(requiredPart(xmlParts, "[Content_Types].xml")));
  for (const name of entryNames) {
    const auxiliary = AUXILIARY_PART.exec(name);
    if (auxiliary && contentTypes.get(`/${name}`) !== `application/vnd.openxmlformats-officedocument.wordprocessingml.${auxiliary[1]}+xml`) {
      throw new DocumentParseError("DOCUMENT_UNSAFE");
    }
  }
  const relationshipsByOwner = /* @__PURE__ */ new Map();
  for (const [name, content] of xmlParts) {
    if (!name.endsWith(".rels")) continue;
    const owner = relationshipOwner(name);
    if (owner && !entryNames.has(owner)) throw new DocumentParseError("DOCUMENT_UNSAFE");
    relationshipsByOwner.set(owner, inspectRelationships(decodeXml(content), owner, entryNames));
  }
  const main = extractDocumentBlocks(
    decodeXml(requiredPart(xmlParts, "word/document.xml")),
    "word/document.xml",
    relationshipsByOwner.get("word/document.xml") ?? /* @__PURE__ */ new Map()
  );
  const blocks = [...main.blocks];
  const qualityReasons = /* @__PURE__ */ new Set(["native-ooxml-structure", ...main.qualityReasons]);
  const referencedParts = /* @__PURE__ */ new Set();
  for (const reference of main.references) {
    if (referencedParts.has(reference.part)) continue;
    referencedParts.add(reference.part);
    const parsed = extractDocumentBlocks(
      decodeXml(requiredPart(xmlParts, reference.part)),
      reference.part,
      relationshipsByOwner.get(reference.part) ?? /* @__PURE__ */ new Map()
    );
    blocks.push(...parsed.blocks);
    for (const reason of parsed.qualityReasons) qualityReasons.add(reason);
  }
  for (const [name, content] of xmlParts) {
    if (AUXILIARY_PART.test(name) && !referencedParts.has(name)) {
      extractDocumentBlocks(decodeXml(content), name, relationshipsByOwner.get(name) ?? /* @__PURE__ */ new Map());
      qualityReasons.add("unreferenced-header-footer-not-imported");
    }
  }
  if (referencedParts.size > 0) qualityReasons.add("header-footer-appended-once");
  const review = qualityReasons.has(REVIEW_REASON);
  return normalizeDocument({
    documentKind: "docx",
    blocks,
    pageCount: null,
    qualityScore: review ? 0.8 : qualityReasons.has("merged-table-source-cell-order") ? 0.95 : 1,
    qualityReasons: [...qualityReasons]
  });
}
async function inspectArchive(path) {
  const zip = await openPromise(path, {
    lazyEntries: true,
    autoClose: true,
    validateEntrySizes: true,
    strictFileNames: true
  });
  const names = /* @__PURE__ */ new Set();
  let totalUncompressedSize = 0;
  let count = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      count += 1;
      totalUncompressedSize += entry.uncompressedSize;
      if (count > DOCX_MAX_ENTRIES || entry.uncompressedSize > DOCX_MAX_ENTRY_SIZE_BYTES || totalUncompressedSize > DOCX_MAX_UNCOMPRESSED_SIZE_BYTES || hasAbnormalCompressionRatio(entry)) {
        throw new DocumentParseError("DOCX_ARCHIVE_LIMIT");
      }
      if (entry.isEncrypted() || !entry.canDecodeFileData() || ![0, 8].includes(entry.compressionMethod) || isUnsafeEntryName(entry.fileName) || !isAllowedEntry(entry.fileName) || names.has(entry.fileName)) {
        throw new DocumentParseError("DOCUMENT_UNSAFE");
      }
      names.add(entry.fileName);
    }
  } finally {
    if (zip.isOpen) zip.close();
  }
  return names;
}
async function readXmlParts(path) {
  const zip = await openPromise(path, {
    lazyEntries: true,
    autoClose: true,
    validateEntrySizes: true,
    strictFileNames: true
  });
  const parts = /* @__PURE__ */ new Map();
  try {
    for await (const entry of zip.eachEntry()) {
      if (!XML_ENTRIES.has(entry.fileName) && !AUXILIARY_PART.test(entry.fileName) && !entry.fileName.endsWith(".rels")) continue;
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = [];
      let size = 0;
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > DOCX_MAX_ENTRY_SIZE_BYTES) {
          throw new DocumentParseError("DOCX_ARCHIVE_LIMIT");
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
function inspectContentTypes(xml) {
  assertSafeXmlPreamble(xml);
  const overrides = /* @__PURE__ */ new Map();
  let root = false;
  const parser = strictParser();
  parser.on("opentag", (tag) => {
    if (!root) {
      root = true;
      if (tag.uri !== CONTENT_TYPES_NAMESPACE || tag.local !== "Types") unsafe();
      return;
    }
    if (tag.uri !== CONTENT_TYPES_NAMESPACE || !["Override", "Default"].includes(tag.local)) unsafe();
    const contentType = attributeValue(tag, "ContentType") ?? "";
    const partName = attributeValue(tag, "PartName") ?? "";
    if (/macroEnabled|vbaProject|oleObject/i.test(contentType)) unsafe();
    if (tag.local === "Override") {
      if (!partName.startsWith("/") || overrides.has(partName)) unsafe();
      overrides.set(partName, contentType);
    }
  });
  parseXml(parser, xml);
  if (overrides.get("/word/document.xml") !== DOCUMENT_CONTENT_TYPE) unsafe();
  return overrides;
}
function relationshipOwner(name) {
  if (name === "_rels/.rels") return "";
  const match = /^word\/_rels\/([^/]+)\.rels$/u.exec(name);
  if (!match) unsafe();
  return `word/${match[1]}`;
}
function inspectRelationships(xml, owner, entries) {
  assertSafeXmlPreamble(xml);
  const relationships = /* @__PURE__ */ new Map();
  let depth = 0;
  const parser = strictParser();
  parser.on("opentag", (tag) => {
    depth += 1;
    if (depth === 1) {
      if (tag.uri !== RELATIONSHIPS_NAMESPACE || tag.local !== "Relationships") unsafe();
      return;
    }
    if (depth !== 2 || tag.uri !== RELATIONSHIPS_NAMESPACE || tag.local !== "Relationship") unsafe();
    const id = attributeValue(tag, "Id") ?? "";
    const type = attributeValue(tag, "Type") ?? "";
    const rawTarget = attributeValue(tag, "Target") ?? "";
    const mode = (attributeValue(tag, "TargetMode") ?? "").trim().toLowerCase();
    if (!id || id.length > 200 || relationships.has(id) || !rawTarget || !["", "internal", "external"].includes(mode)) unsafe();
    if (type === `${OFFICE_RELATIONSHIPS_NAMESPACE}/hyperlink`) {
      if (owner !== "word/document.xml" && !AUXILIARY_PART.test(owner)) unsafe();
      if (mode === "external") {
        if (!isPassiveTarget(rawTarget)) unsafe();
        relationships.set(id, { type, target: rawTarget, external: true });
      } else {
        if (!/^#[^\s#\\\x00-\x1f\x7f]{1,200}$/u.test(rawTarget)) unsafe();
        relationships.set(id, { type, target: rawTarget, external: false });
      }
      return;
    }
    if (mode === "external") unsafe();
    const target = resolvePart(owner, rawTarget);
    if (!entries.has(target) || !isAllowedRelationship(type, owner, target)) unsafe();
    relationships.set(id, { type, target, external: false });
  });
  parser.on("closetag", () => {
    depth -= 1;
  });
  parseXml(parser, xml);
  return relationships;
}
function isAllowedRelationship(type, owner, target) {
  if (owner === "") {
    return type === `${OFFICE_RELATIONSHIPS_NAMESPACE}/officeDocument` && target === "word/document.xml" || type === `${RELATIONSHIPS_NAMESPACE}/metadata/core-properties` && target === "docProps/core.xml" || type === `${OFFICE_RELATIONSHIPS_NAMESPACE}/extended-properties` && target === "docProps/app.xml";
  }
  const kind = type.startsWith(`${OFFICE_RELATIONSHIPS_NAMESPACE}/`) ? type.slice(OFFICE_RELATIONSHIPS_NAMESPACE.length + 1) : "";
  if (kind === "header" || kind === "footer") {
    return owner === "word/document.xml" && AUXILIARY_PART.test(target) && target.startsWith(`word/${kind}`);
  }
  if (["styles", "numbering", "settings", "fontTable", "webSettings"].includes(kind)) return target === `word/${kind}.xml`;
  if (kind === "theme") return /^word\/theme\/theme\d+\.xml$/u.test(target);
  if (kind === "image") return /^word\/media\/[^/]+\.(?:png|jpe?g|gif|bmp|tiff?)$/iu.test(target);
  return false;
}
function resolvePart(owner, target) {
  if (target.length > 500 || /[\\%?#\x00-\x20\x7f]/u.test(target) || /^(?:\/|[a-z][a-z0-9+.-]*:)/iu.test(target)) unsafe();
  const segments = owner.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (!segment) unsafe();
    if (segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) unsafe();
      segments.pop();
    } else segments.push(segment);
  }
  return segments.join("/");
}
function isPassiveTarget(target) {
  if (target.length > 2048 || /[\\\x00-\x20\x7f]/u.test(target) || /%0[ad]/iu.test(target)) return false;
  try {
    const url = new URL(target);
    if (url.username || url.password) return false;
    if (url.protocol === "http:" || url.protocol === "https:") return /^https?:\/\//iu.test(target) && url.hostname.length > 0;
    return url.protocol === "mailto:" && url.pathname.length > 0 && !/^mailto:\/\//iu.test(target);
  } catch {
    return false;
  }
}
function extractDocumentBlocks(xml, sourcePart, relationships) {
  assertSafeXmlPreamble(xml);
  const prefix = sourcePart === "word/document.xml" ? "document" : sourcePart;
  const expectedRoot = sourcePart === "word/document.xml" ? "document" : sourcePart.startsWith("word/header") ? "hdr" : "ftr";
  const completed = [];
  const paragraphs = [];
  const tables = [];
  const quality = /* @__PURE__ */ new Set();
  const references = [];
  const ancestors = [];
  let topTable = 0, topParagraph = 0, paragraphOrder = 0, textDepth = 0, instructionDepth = 0, totalText = 0;
  let instruction = "";
  let fieldInstruction = "";
  const parser = strictParser();
  const review = (reason) => {
    quality.add(REVIEW_REASON);
    quality.add(reason);
  };
  parser.on("opentag", (tag) => {
    if (ancestors.length === 0 && (tag.uri !== WORD_NAMESPACE || tag.local !== expectedRoot)) unsafe();
    if (tag.prefix === "w" && tag.uri !== WORD_NAMESPACE || /^(?:OLEObject|object|control)$/iu.test(tag.local)) unsafe();
    if (tag.uri !== WORD_NAMESPACE) {
      if (["AlternateContent", "Choice", "Fallback"].includes(tag.local)) review("alternate-content-source-order");
      else review("unsupported-namespace-text-not-imported");
      ancestors.push({ uri: tag.uri, local: tag.local });
      return;
    }
    const paragraph = paragraphs.at(-1);
    const table = tables.at(-1);
    switch (tag.local) {
      case "altChunk":
      case "subDoc":
      case "attachedTemplate":
        unsafe();
      case "headerReference":
      case "footerReference": {
        if (sourcePart !== "word/document.xml" || !ancestors.some((node) => node.uri === WORD_NAMESPACE && node.local === "sectPr")) unsafe();
        const id = attributeValue(tag, "id", OFFICE_RELATIONSHIPS_NAMESPACE);
        const kind = tag.local === "headerReference" ? "header" : "footer";
        const relationship = id ? relationships.get(id) : void 0;
        if (!relationship || relationship.external || relationship.type !== `${OFFICE_RELATIONSHIPS_NAMESPACE}/${kind}`) unsafe();
        references.push({ part: relationship.target, kind });
        break;
      }
      case "hyperlink": {
        const id = attributeValue(tag, "id", OFFICE_RELATIONSHIPS_NAMESPACE);
        const anchor = attributeValue(tag, "anchor", WORD_NAMESPACE);
        const relationship = id ? relationships.get(id) : void 0;
        if (id ? !relationship || relationship.type !== `${OFFICE_RELATIONSHIPS_NAMESPACE}/hyperlink` : !anchor) unsafe();
        quality.add("passive-hyperlink-display-text-only");
        break;
      }
      case "tbl": {
        if (tables.length >= MAX_TABLE_DEPTH || table && !table.cellOpen) unsafe();
        if (paragraph) review("nested-paragraph-source-order");
        const tablePath = table ? `${table.path}/row[${table.row}]/cell[${table.cell}]/table[${++table.childTable}]` : `${prefix}/table[${++topTable}]`;
        if (table) review("nested-table-source-cell-order");
        tables.push({ path: tablePath, row: 0, cell: 0, paragraph: 0, childTable: 0, rowOpen: false, cellOpen: false });
        quality.add("table-source-cell-order");
        break;
      }
      case "tr":
        if (!table || table.rowOpen || table.cellOpen) unsafe();
        table.row += 1;
        table.cell = 0;
        table.rowOpen = true;
        break;
      case "tc":
        if (!table || !table.rowOpen || table.cellOpen) unsafe();
        table.cell += 1;
        table.paragraph = 0;
        table.childTable = 0;
        table.cellOpen = true;
        break;
      case "p": {
        if (table && !table.cellOpen) unsafe();
        if (paragraph) review("nested-paragraph-source-order");
        const path = table ? `${table.path}/row[${table.row}]/cell[${table.cell}]/paragraph[${++table.paragraph}]` : `${prefix}/paragraph[${++topParagraph}]`;
        paragraphs.push({ blockType: table ? "tableCell" : "paragraph", path, text: "", order: paragraphOrder++ });
        if (paragraphOrder > DOCUMENT_MAX_BLOCKS) unsafe();
        break;
      }
      case "numPr":
        if (paragraph?.blockType === "paragraph") paragraph.blockType = "listItem";
        break;
      case "gridSpan":
      case "vMerge":
      case "hMerge":
        quality.add("merged-table-source-cell-order");
        break;
      case "drawing":
      case "pict":
      case "txbxContent":
        review("non-text-or-textbox-source-order");
        break;
      case "ins":
      case "del":
      case "moveFrom":
      case "moveTo":
        review("tracked-changes-source-text");
        break;
      case "delText":
        review("tracked-deleted-text-not-imported");
        break;
      case "sym":
        review("symbol-font-text-not-decoded");
        break;
      case "footnoteReference":
      case "endnoteReference":
      case "commentReference":
        review("unsupported-reference-not-imported");
        break;
      case "fldSimple": {
        const command = attributeValue(tag, "instr", WORD_NAMESPACE) ?? "";
        assertSafeField(command);
        review("field-display-text-only");
        break;
      }
      case "fldChar": {
        const kind = attributeValue(tag, "fldCharType", WORD_NAMESPACE);
        if (kind === "begin" || kind === "end") {
          assertSafeField(fieldInstruction);
          fieldInstruction = "";
        }
        review("field-display-text-only");
        break;
      }
      case "instrText":
        instructionDepth += 1;
        instruction = "";
        review("field-display-text-only");
        break;
      case "t":
        textDepth += 1;
        break;
      case "tab":
        if (paragraph) paragraph.text += "	";
        break;
      case "br":
      case "cr":
        if (paragraph) paragraph.text += "\n";
        break;
    }
    ancestors.push({ uri: tag.uri, local: tag.local });
  });
  const collectText = (text) => {
    if (instructionDepth > 0) instruction += text;
    if (textDepth > 0) {
      const paragraph = paragraphs.at(-1);
      if (!paragraph) unsafe();
      paragraph.text += text;
      totalText += text.length;
      if (totalText > DOCUMENT_MAX_TEXT_LENGTH) unsafe();
    }
  };
  parser.on("text", collectText);
  parser.on("cdata", collectText);
  parser.on("closetag", (tag) => {
    ancestors.pop();
    if (tag.uri !== WORD_NAMESPACE) return;
    const table = tables.at(-1);
    switch (tag.local) {
      case "t":
        textDepth -= 1;
        break;
      case "instrText":
        assertSafeField(instruction);
        fieldInstruction += instruction;
        instructionDepth -= 1;
        break;
      case "p": {
        const paragraph = paragraphs.pop();
        if (!paragraph) unsafe();
        completed.push({ order: paragraph.order, block: {
          kind: "docx",
          blockType: paragraph.blockType,
          path: paragraph.path,
          text: paragraph.text,
          ...sourcePart === "word/document.xml" ? {} : { sourcePart }
        } });
        break;
      }
      case "tc":
        if (!table || !table.cellOpen) unsafe();
        table.cellOpen = false;
        break;
      case "tr":
        if (!table || !table.rowOpen || table.cellOpen) unsafe();
        table.rowOpen = false;
        break;
      case "tbl":
        if (!table || table.rowOpen || table.cellOpen) unsafe();
        tables.pop();
        break;
    }
  });
  parseXml(parser, xml);
  assertSafeField(fieldInstruction);
  return { blocks: completed.sort((left, right) => left.order - right.order).map(({ block }) => block), references, qualityReasons: [...quality] };
}
function assertSafeField(command) {
  if (/\b(?:DDE(?:AUTO)?|INCLUDETEXT|INCLUDEPICTURE|DATABASE|LINK)\b/iu.test(command)) unsafe();
  const hyperlink = /\bHYPERLINK\s+(?:"([^"]+)"|(\S+))/iu.exec(command);
  if (hyperlink && !isPassiveTarget(hyperlink[1] ?? hyperlink[2] ?? "")) unsafe();
}
function unsafe() {
  throw new DocumentParseError("DOCUMENT_UNSAFE");
}
function strictParser() {
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => {
    throw new DocumentParseError("DOCUMENT_UNSAFE");
  });
  parser.on("processinginstruction", (instruction) => {
    if (instruction.target.toLowerCase() !== "xml") {
      throw new DocumentParseError("DOCUMENT_UNSAFE");
    }
  });
  return parser;
}
function parseXml(parser, xml) {
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof DocumentParseError) throw error;
    throw new DocumentParseError("DOCUMENT_UNSAFE");
  }
}
function assertSafeXmlPreamble(xml) {
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml)) {
    throw new DocumentParseError("DOCUMENT_UNSAFE");
  }
}
function attributeValue(tag, localName, namespace = "") {
  return Object.values(tag.attributes).find((attribute) => attribute.local === localName && attribute.uri === namespace)?.value;
}
function decodeXml(buffer) {
  if (buffer[0] === 255 && buffer[1] === 254) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 254 && buffer[1] === 255) {
    throw new DocumentParseError("DOCUMENT_UNSAFE");
  }
  return buffer.toString("utf8").replace(/^\uFEFF/u, "");
}
function requiredPart(parts, name) {
  const part = parts.get(name);
  if (!part) throw new DocumentParseError("DOCUMENT_UNSAFE");
  return part;
}
function hasAbnormalCompressionRatio(entry) {
  return entry.uncompressedSize >= COMPRESSION_RATIO_MIN_BYTES && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO);
}
function isUnsafeEntryName(name) {
  return name.startsWith("/") || /^[a-z]:/iu.test(name) || name.includes("\\") || name.includes("\0") || name.split("/").some((segment) => segment === "..");
}
function isAllowedEntry(name) {
  if (/vbaProject|macros?|embeddings?|oleObject/i.test(name)) return false;
  return name === "[Content_Types].xml" || name === "_rels/.rels" || /^docProps\/(?:core|app)\.xml$/u.test(name) || /^word\/(?:document|styles|numbering|settings|fontTable|webSettings)\.xml$/u.test(name) || AUXILIARY_PART.test(name) || AUXILIARY_RELATIONSHIPS.test(name) || /^word\/_rels\/(?:document|styles|numbering|settings|fontTable)\.xml\.rels$/u.test(name) || /^word\/theme\/theme\d+\.xml$/u.test(name) || /^word\/media\/[^/]+\.(?:png|jpe?g|gif|bmp|tiff?)$/iu.test(name) || /^(?:_rels|docProps|word|word\/_rels|word\/theme|word\/media)\/$/u.test(name);
}

// src/materials/vendor/parser/inspect-upload.ts
import { lstat, open } from "node:fs/promises";
import { open as openZip } from "yauzl";
var UploadInspectionError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "UploadInspectionError";
  }
  code;
};
var PDF_SIGNATURE = Buffer.from("%PDF-");
var PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
async function inspectDocumentSignature(path) {
  try {
    return await readDocumentSignature(path);
  } catch (error) {
    if (error instanceof UploadInspectionError) throw error;
    throw new UploadInspectionError(isFileSystemError(error) ? "DOCUMENT_READ_FAILED" : "DOCUMENT_UNSAFE");
  }
}
async function readDocumentSignature(path) {
  const signature = await readSignature(path, 8);
  if (signature.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
    return { detectedMime: "application/pdf", documentKind: "pdf" };
  }
  if (signature.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { detectedMime: "image/png", documentKind: "image" };
  }
  if (signature[0] === 255 && signature[1] === 216 && signature[2] === 255) {
    return { detectedMime: "image/jpeg", documentKind: "image" };
  }
  if (signature[0] === 80 && signature[1] === 75 && signature[2] === 3 && signature[3] === 4) {
    return {
      detectedMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      documentKind: "docx"
    };
  }
  throw new UploadInspectionError("FILE_TYPE_MISMATCH");
}
async function readSignature(path, length) {
  const entry = await lstat(path);
  if (!entry.isFile()) throw new UploadInspectionError("DOCUMENT_UNSAFE");
  if (entry.size > MAX_FILE_SIZE_BYTES) throw new UploadInspectionError("DOCUMENT_TOO_LARGE");
  const handle = await open(path, "r");
  try {
    const openedFile = await handle.stat();
    if (!openedFile.isFile()) throw new UploadInspectionError("DOCUMENT_UNSAFE");
    if (openedFile.size > MAX_FILE_SIZE_BYTES) throw new UploadInspectionError("DOCUMENT_TOO_LARGE");
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

// src/materials/vendor/parser/pdf.ts
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { AnnotationType, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
var ACTIVE_PDF_NAMES = /* @__PURE__ */ new Set([
  "JavaScript",
  "JS",
  "OpenAction",
  "AA",
  "EmbeddedFiles",
  "Filespec",
  "Launch",
  "GoToR",
  "GoToE",
  "Named",
  "SubmitForm",
  "ImportData",
  "ResetForm",
  "Hide",
  "SetOCGState",
  "Rendition",
  "Sound",
  "Movie",
  "RichMedia",
  "Next",
  "ObjStm",
  "Encrypt"
]);
var require2 = createRequire(import.meta.url);
var PDFJS_ROOT = resolve(dirname(require2.resolve("pdfjs-dist/legacy/build/pdf.mjs")), "../..");
var PDFJS_CMAP_URL = `${resolve(PDFJS_ROOT, "cmaps").replaceAll("\\", "/")}/`;
var PDFJS_STANDARD_FONT_URL = `${resolve(PDFJS_ROOT, "standard_fonts").replaceAll("\\", "/")}/`;
async function parsePdf(path) {
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
    disableAutoFetch: true
  });
  let document;
  try {
    document = await loadingTask.promise;
    if (document.numPages > MAX_PDF_PAGES) {
      throw new DocumentParseError("PDF_TOO_MANY_PAGES");
    }
    await assertSafeDocument(document);
    const blocks = [];
    const pageCharacterCounts = [];
    let readingOrderReview = false, columnCandidate = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      await assertSafePage(page);
      const textContent = await page.getTextContent({ disableNormalization: false });
      const pageResult = buildPageBlocks(textContent.items, pageNumber);
      readingOrderReview ||= pageResult.readingOrderReview;
      columnCandidate ||= pageResult.columnCandidate;
      blocks.push(...pageResult.blocks);
      if (blocks.length > DOCUMENT_MAX_BLOCKS) throw new DocumentParseError("DOCUMENT_UNSAFE");
      pageCharacterCounts.push(nonWhitespaceLength(pageResult.blocks.map((block) => block.text).join("")));
      page.cleanup();
    }
    const totalCharacters = pageCharacterCounts.reduce((total, count) => total + count, 0);
    const textPoorPages = pageCharacterCounts.filter(
      (count) => count < PDF_OCR_MIN_PAGE_CHARS
    ).length;
    if (totalCharacters < PDF_OCR_MIN_NON_WHITESPACE_CHARS || document.numPages > 1 && textPoorPages > document.numPages / 2) {
      return { status: "OCR_REQUIRED", reason: "insufficient-text" };
    }
    const qualityReasons = textPoorPages > 0 ? ["partial-text-layer"] : ["native-text-layer"];
    if (readingOrderReview) qualityReasons.push(
      "reading-order-review-required",
      columnCandidate ? "two-column-order-candidate" : "layout-fragments-preserved"
    );
    return {
      status: "PARSED",
      result: normalizeDocument({
        documentKind: "pdf",
        blocks,
        pageCount: document.numPages,
        qualityScore: readingOrderReview ? 0.8 : textPoorPages > 0 ? 0.9 : 1,
        qualityReasons
      })
    };
  } catch (error) {
    if (error instanceof DocumentParseError || isFileSystemError(error)) throw error;
    throw new DocumentParseError("DOCUMENT_UNSAFE");
  } finally {
    await loadingTask.destroy();
  }
}
async function assertSafeDocument(document) {
  const [javaScriptActions, openAction, attachments] = await Promise.all([
    document.getJSActions(),
    document.getOpenAction(),
    document.getAttachments()
  ]);
  if (hasActionValues(javaScriptActions) || openAction !== null || hasActionValues(attachments)) {
    throw new DocumentParseError("DOCUMENT_UNSAFE");
  }
}
async function assertSafePage(page) {
  const [javaScriptActions, annotations] = await Promise.all([
    page.getJSActions(),
    page.getAnnotations({ intent: "any" })
  ]);
  if (hasActionValues(javaScriptActions)) throw new DocumentParseError("DOCUMENT_UNSAFE");
  for (const annotation of annotations) {
    if (classifyAnnotation(annotation) === "unsafe") throw new DocumentParseError("DOCUMENT_UNSAFE");
  }
}
function assertNoActivePdfNames(bytes) {
  for (const match of bytes.toString("latin1").matchAll(/\/([^\s\x00()[\]<>/%{}]+)/gu)) {
    const name = match[1].replace(/#([a-f0-9]{2})/giu, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (ACTIVE_PDF_NAMES.has(name)) throw new DocumentParseError("DOCUMENT_UNSAFE");
  }
}
function safePassiveUri(value) {
  if (typeof value !== "string" || !value || value.length > 8192 || value.trim() !== value || /[\u0000-\u0020\u007f\\]/u.test(value)) return false;
  try {
    const target = new URL(value);
    return target.protocol === "http:" || target.protocol === "https:" ? !!target.hostname && !target.username && !target.password : target.protocol === "mailto:" && !!target.pathname && !target.hash;
  } catch {
    return false;
  }
}
function classifyAnnotation(annotation) {
  if (annotation.annotationType === AnnotationType.FILEATTACHMENT || annotation.file !== void 0 || annotation.action !== void 0 || annotation.dest !== void 0 || annotation.hasJSActions === true || hasActionValues(annotation.jsActions) || annotation.resetForm !== void 0 || annotation.setOCGState !== void 0 || annotation.submitForm !== void 0 || annotation.attachment !== void 0 || hasActionValues(annotation.actions)) return "unsafe";
  if (annotation.annotationType === AnnotationType.LINK) {
    return safePassiveUri(annotation.unsafeUrl) && safePassiveUri(annotation.url) ? "passive-link" : "unsafe";
  }
  return annotation.url !== void 0 || annotation.unsafeUrl !== void 0 ? "unsafe" : "inert";
}
function buildPageBlocks(items, pageNumber) {
  const positioned = items.filter(isTextItem).filter((item) => item.str.trim().length > 0).map((item) => ({
    text: item.str,
    x: finiteCoordinate(item.transform[4]),
    y: finiteCoordinate(item.transform[5]),
    width: Math.max(0, finiteCoordinate(item.width)),
    height: Math.max(0, finiteCoordinate(item.height)),
    hasEOL: item.hasEOL
  })).sort((left, right) => right.y - left.y || left.x - right.x);
  if (positioned.length > 1e5) throw new DocumentParseError("DOCUMENT_UNSAFE");
  const lines = [];
  for (const item of positioned) {
    const line = lines.at(-1);
    if (line && Math.abs((line[0]?.y ?? 0) - item.y) <= 2.5) line.push(item);
    else lines.push([item]);
  }
  let wideGutter = false;
  const fragments = lines.flatMap((line) => {
    const ordered = line.sort((left, right) => left.x - right.x), groups = [[]];
    for (const item of ordered) {
      const previous = groups.at(-1).at(-1);
      if (previous && item.x - previous.x - previous.width > Math.max(54, previous.height * 4, item.height * 4)) {
        wideGutter = true;
        groups.push([]);
      }
      groups.at(-1).push(item);
    }
    return groups.filter((group) => group.length > 0);
  });
  const starts = [...new Set(fragments.map((fragment) => fragment[0].x))].sort((a, b) => a - b);
  let gap = 0, rightStart = 0;
  for (let index = 1; index < starts.length; index++) {
    const candidate = starts[index] - starts[index - 1];
    if (candidate > gap) {
      gap = candidate;
      rightStart = starts[index];
    }
  }
  let orderedFragments = fragments, columnCandidate = false;
  if (gap >= 72) {
    const left = fragments.filter((fragment) => fragment[0].x < rightStart && fragment.every((item) => item.x + item.width <= rightStart - 24));
    const right = fragments.filter((fragment) => fragment.every((item) => item.x >= rightStart));
    if (left.length >= 2 && right.length >= 2) {
      columnCandidate = true;
      const body = /* @__PURE__ */ new Set([...left, ...right]), spanners = fragments.filter((fragment) => !body.has(fragment));
      const top = Math.max(...[...left, ...right].map((fragment) => fragment[0].y));
      const bottom = Math.min(...[...left, ...right].map((fragment) => fragment[0].y));
      const header = spanners.filter((fragment) => fragment[0].y > top + 2.5), footer = spanners.filter((fragment) => fragment[0].y < bottom - 2.5);
      if (header.length + footer.length === spanners.length) orderedFragments = [...header, ...left, ...right, ...footer];
    }
  }
  const blocks = orderedFragments.map((line) => ({
    kind: "pdf",
    pageNumber,
    text: joinLine(line),
    bbox: lineBoundingBox(line)
  })).filter((block) => block.text.trim().length > 0);
  return { blocks, readingOrderReview: wideGutter || columnCandidate, columnCandidate };
}
function joinLine(line) {
  let text = "";
  let previous;
  for (const item of line) {
    if (previous && shouldInsertSpace(previous, item, text)) text += " ";
    text += item.text;
    previous = item;
  }
  return text.trim();
}
function shouldInsertSpace(previous, current, text) {
  if (/\s$/u.test(text) || /^\s/u.test(current.text)) return false;
  const gap = current.x - (previous.x + previous.width);
  return previous.hasEOL || gap > 0.5;
}
function lineBoundingBox(line) {
  const minX = Math.min(...line.map((item) => item.x));
  const minY = Math.min(...line.map((item) => item.y));
  const maxX = Math.max(...line.map((item) => item.x + item.width));
  const maxY = Math.max(...line.map((item) => item.y + item.height));
  return {
    x: roundCoordinate(minX),
    y: roundCoordinate(minY),
    width: roundCoordinate(Math.max(0, maxX - minX)),
    height: roundCoordinate(Math.max(0, maxY - minY))
  };
}
function isTextItem(value) {
  return typeof value === "object" && value !== null && "str" in value && typeof value.str === "string" && "transform" in value && Array.isArray(value.transform);
}
function hasActionValues(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  return Object.values(value).some(
    (item) => Array.isArray(item) ? item.length > 0 : item !== void 0 && item !== null
  );
}
function nonWhitespaceLength(value) {
  return value.replace(/\s/gu, "").length;
}
function finiteCoordinate(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function roundCoordinate(value) {
  return Math.round(value * 1e3) / 1e3;
}

// src/materials/vendor/parser/parse-document.ts
async function parseDocument(path, documentKind) {
  if (documentKind === "image") return { status: "OCR_REQUIRED", reason: "image" };
  if (documentKind !== "pdf" && documentKind !== "docx") {
    return { status: "FAILED", code: "FILE_TYPE_MISMATCH" };
  }
  try {
    const inspection = await inspectDocumentSignature(path);
    if (inspection.documentKind !== documentKind) {
      throw new DocumentParseError("FILE_TYPE_MISMATCH");
    }
    const outcome = documentKind === "pdf" ? await parsePdf(path) : { status: "PARSED", result: await parseDocx(path) };
    if (outcome.status === "PARSED") {
      return { status: "PARSED", result: freezeDocumentResult(outcome.result) };
    }
    return outcome;
  } catch (error) {
    return { status: "FAILED", code: failureCode(error) };
  }
}
function failureCode(error) {
  if (isFileSystemError(error)) return "DOCUMENT_READ_FAILED";
  if (error instanceof DocumentParseError || error instanceof UploadInspectionError) return error.code;
  if (error instanceof Error && error.message === "DOCUMENT_RESULT_INVALID") return "DOCUMENT_RESULT_INVALID";
  return "DOCUMENT_UNSAFE";
}
export {
  DocumentParseError,
  parseDocument
};
