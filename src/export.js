import { readFile } from 'node:fs/promises';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Footer, AlignmentType, PageNumber } from 'docx';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const error = (code, message) => Object.assign(new Error(message), { code });
function reportSections(report) {
  if (report.language === 'en') {
    const names = { relevance: 'Relevance', evidence: 'Evidence in the answer', reasoning: 'Reasoning and explanation', clarity: 'Clarity' };
    const rows = [{ title: 'Interview report', text: report.summary }, { title: 'Score', text: report.total == null ? 'There is not enough evidence to give a total score.' : `Total ${report.total} / 100` }];
    for (const criterion of report.criteria ?? []) rows.push({ title: names[criterion.id] ?? criterion.name ?? criterion.id,
      text: [criterion.reason, ...(criterion.evidence ?? []).map(item => `Answer evidence: ${item.quote}`)].filter(Boolean).join('\n') });
    for (const [key, title] of [['strengths', 'Demonstrated strengths'], ['improvements', 'Areas to improve'], ['nextSteps', 'Next practice']]) {
      if (report[key]?.length) rows.push({ title, text: report[key].map((item, index) => `${index + 1}. ${item}`).join('\n') });
    }
    rows.push({ title: 'Record', text: `Report ${report.id}\nResume version ${report.versionId}\nRubric ${report.rubricVersion}\nCreated ${report.createdAt}` });
    return rows;
  }
  const rows = [{ title: '面试报告', text: report.summary }, { title: '评分', text: report.total == null ? '当前证据不足，未给出总分。' : `总分 ${report.total} / 100` }];
  for (const criterion of report.criteria ?? []) rows.push({ title: criterion.name ?? criterion.label ?? criterion.id,
    text: [criterion.reason, ...((criterion.evidence ?? []).map(item => `回答依据：${item.quote}`))].filter(Boolean).join('\n') });
  for (const [key, title] of [['strengths', '已表现的优点'], ['improvements', '改进建议'], ['nextSteps', '下次练习']]) {
    if (report[key]?.length) rows.push({ title, text: report[key].map((item, index) => `${index + 1}. ${item}`).join('\n') });
  }
  rows.push({ title: '记录', text: `报告 ${report.id}\n简历版本 ${report.versionId}\n评分标准 ${report.rubricVersion}\n生成时间 ${report.createdAt}` });
  return rows;
}
async function content(career, { kind, id }) {
  if (typeof id !== 'string' || id.length > 200) throw error('INVALID_EXPORT', '请选择要导出的版本或报告。');
  if (kind === 'report') { const report = await career.dispatch('report.get', { reportId: id }); return { title: report.language === 'en' ? 'Zhijing interview report' : '职镜AI面试报告', sections: reportSections(report) }; }
  if (kind !== 'resume') throw error('INVALID_EXPORT', '不支持的导出内容。');
  const state = await career.dispatch('state', {});
  const material = state.materials.find(item => item.kind === 'resume' && item.versions.some(version => version.id === id));
  const version = material?.versions.find(row => row.id === id);
  if (!version) throw error('VERSION_NOT_FOUND', '找不到所选简历版本。');
  if (!version.confirmed) throw error('MATERIAL_NOT_CONFIRMED', '请先确认简历内容后再导出。');
  return { title: material.title, sections: [{ title: null, text: version.text }] };
}
function docxBytes({ title, sections }) {
  const children = [];
  for (const section of sections) {
    if (section.title) children.push(new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } }));
    for (const line of section.text.split('\n')) children.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Noto Sans SC', size: 22 })], spacing: { after: 100, line: 320 } }));
  }
  return Packer.toBuffer(new Document({ title, creator: '职镜AI', styles: { default: { document: { run: { font: 'Noto Sans SC', size: 22 } } } },
    sections: [{ properties: { page: { margin: { top: 960, bottom: 960, left: 960, right: 960 } } }, children,
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT] })] })] }) } }] }));
}
async function pdfBytes({ title, sections }) {
  const pdf = await PDFDocument.create(); pdf.setTitle(title); pdf.setCreator('职镜AI');
  pdf.registerFontkit(fontkit);
  // pdf-lib/fontkit CFF subsetting omits some Chinese outlines. Embed the verified
  // static font intact so exported files render without installed system fonts.
  // Noto's Latin `locl` substitution uses alternate digit glyphs absent from the
  // full-font Unicode cmap that pdf-lib embeds. Keep the original cmap glyphs so
  // English numbers remain copyable/searchable; this is already the SC font.
  const font = await pdf.embedFont(await readFile(new URL('../assets/fonts/NotoSansCJKsc-Regular.otf', import.meta.url)),
    { subset: false, features: { locl: false } });
  const width = 595.28, height = 841.89, margin = 48;
  let page, y;
  const nextPage = () => { page = pdf.addPage([width, height]); y = height - margin; };
  nextPage();
  const draw = (text, size, color = rgb(0.12, 0.15, 0.19)) => {
    const lineHeight = size * 1.7;
    let line = '';
    const flush = () => {
      if (y - lineHeight < margin) nextPage();
      page.drawText(line || ' ', { x: margin, y: y - size, size, font, color }); y -= lineHeight; line = '';
    };
    // Keep ordinary Latin words intact. CJK still wraps between characters;
    // only a token wider than the whole page (for example a long URL) splits.
    const available = width - margin * 2;
    const tokens = text.replaceAll('\t', '    ').match(/[\p{Script=Latin}\p{M}\d]+(?:['’._/@:\-][\p{Script=Latin}\p{M}\d]+)*| +|[^\r\n]/gu) ?? [];
    for (const token of tokens) {
      if (line && font.widthOfTextAtSize(line + token, size) > available) {
        line = line.trimEnd(); flush();
        if (/^ +$/u.test(token)) continue;
      }
      if (font.widthOfTextAtSize(token, size) <= available) { line += token; continue; }
      for (const char of token) {
        if (line && font.widthOfTextAtSize(line + char, size) > available) flush();
        line += char;
      }
    }
    flush();
  };
  for (const section of sections) {
    if (section.title) { y -= 10; if (y < margin + 65) nextPage(); draw(section.title, 15); y -= 3; }
    for (const line of section.text.split('\n')) draw(line, 10.5);
    y -= 10;
  }
  pdf.getPages().forEach((item, index) => item.drawText(`${index + 1} / ${pdf.getPageCount()}`, { x: width / 2 - 12, y: 24, size: 9, font, color: rgb(0.45, 0.45, 0.45) }));
  return Buffer.from(await pdf.save());
}
/** Export only persisted, selected business objects; paths and arbitrary HTML are not accepted. */
export async function exportCareerDocument(career, input) {
  if (!['docx', 'pdf'].includes(input.format)) throw error('INVALID_EXPORT', '请选择 Word 或 PDF。');
  const document = await content(career, input);
  return { bytes: input.format === 'docx' ? await docxBytes(document) : await pdfBytes(document),
    mime: input.format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf',
    filename: `${document.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 80)}.${input.format}` };
}
