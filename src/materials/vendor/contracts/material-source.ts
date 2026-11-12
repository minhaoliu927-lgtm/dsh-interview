import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
const fixed = { additionalProperties: false } as const;
const nullableText = (maximum: number) => Type.Union([Type.String({ minLength: 1, maxLength: maximum }), Type.Null()]);
const box = Type.Object({ x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }), width: Type.Number({ minimum: 0 }), height: Type.Number({ minimum: 0 }) }, fixed);
const word = Type.Object({ text: Type.String({ maxLength: 1000 }), box }, fixed);
const line = Type.Object({ text: Type.String({ minLength: 1, maxLength: 10000 }), startOffset: Type.Integer({ minimum: 0, maximum: 200000 }),
  endOffset: Type.Integer({ minimum: 1, maximum: 200000 }), box, words: Type.Array(word, { maxItems: 1000 }) }, fixed);
export const MaterialRecognizedFieldsSchema = Type.Object({ jobTitle: nullableText(500), company: nullableText(500), salary: nullableText(500),
  location: nullableText(500), responsibilities: nullableText(100000), requirements: nullableText(100000) }, fixed);
export type MaterialRecognizedFields = Static<typeof MaterialRecognizedFieldsSchema>;
export const MaterialOcrResultSchema = Type.Object({ engine: Type.Literal('windows-media-ocr'), language: Type.String({ minLength: 1, maxLength: 40 }),
  width: Type.Integer({ minimum: 1, maximum: 10000 }), height: Type.Integer({ minimum: 1, maximum: 10000 }), lines: Type.Array(line, { minItems: 1, maxItems: 10000 }) }, fixed);
export type MaterialOcrResult = Static<typeof MaterialOcrResultSchema>;
export const MaterialAcquisitionSourceSchema = Type.Object({
  method: Type.Union([Type.Literal('public-html-v1'), Type.Literal('windows-ocr-v1')]),
  inputKind: Type.Union([Type.Literal('url'), Type.Literal('uploaded-image'), Type.Literal('pasted-image'), Type.Literal('browser-capture')]),
  sourceUrl: nullableText(2048), finalUrl: nullableText(2048), pageTitle: nullableText(500), capturedAt: Type.Integer({ minimum: 1 }),
  contentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }), originalFileId: nullableText(160),
  originalHash: Type.Union([Type.String({ pattern: '^[a-f0-9]{64}$' }), Type.Null()]), fields: MaterialRecognizedFieldsSchema,
  ocr: Type.Union([MaterialOcrResultSchema, Type.Null()]),
}, fixed);
export type MaterialAcquisitionSource = Static<typeof MaterialAcquisitionSourceSchema>;
/** Shared semantic admission; callers additionally recompute hashes from owned bytes/text. */
export function validateMaterialAcquisitionSource(value: unknown, text: string,
  original?: { id: string; contentHash: string }): asserts value is MaterialAcquisitionSource {
  const reject = (): never => { throw new Error('MATERIALS_INVALID_REQUEST'); };
  if (!Value.Check(MaterialAcquisitionSourceSchema, value) || !text.trim() || text.length > 200000) reject();
  const source = value as MaterialAcquisitionSource;
  for (const input of [source.sourceUrl, source.finalUrl]) if (input !== null) {
    let parsed: URL; try { parsed = new URL(input); } catch { return reject(); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || /[\\\u0000-\u0020\u007f]/u.test(input)) reject();
  }
  for (const field of Object.values(source.fields)) if (field !== null && !text.includes(field)) reject();
  if (source.method === 'public-html-v1') {
    if (source.inputKind !== 'url' || source.sourceUrl === null || source.finalUrl === null || source.ocr !== null
      || source.originalFileId !== null || source.originalHash !== null || original) reject();
    return;
  }
  if (source.inputKind === 'url' || !source.ocr || !original || source.originalFileId !== original.id || source.originalHash !== original.contentHash) reject();
  const ocr = source.ocr!;
  if (ocr.width * ocr.height > 25_000_000) reject();
  const contained = (rectangle: { x: number; y: number; width: number; height: number }) =>
    rectangle.width > 0 && rectangle.height > 0 && rectangle.x + rectangle.width <= ocr.width + 0.01 && rectangle.y + rectangle.height <= ocr.height + 0.01;
  let previous = 0;
  for (const line of ocr.lines) {
    if (line.startOffset < previous || line.endOffset <= line.startOffset || line.endOffset > text.length
      || text.slice(line.startOffset, line.endOffset) !== line.text || !contained(line.box)) reject();
    for (const word of line.words) if (!contained(word.box) || !line.text.includes(word.text)) reject();
    previous = line.endOffset;
  }
}
