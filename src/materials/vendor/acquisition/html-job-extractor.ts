import { parse, parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { createHash } from 'node:crypto';
import type { MaterialAcquisitionSource } from '../contracts/material-source.ts';
import { recognizedFieldsFromText } from './job-fields.ts';
import { isJobVerificationUrl, sanitizeJobSourceUrl } from './public-url-policy.ts';
type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const ignored = new Set(['script', 'style', 'noscript', 'template', 'svg', 'nav', 'footer', 'form', 'button', 'input']);
const block = new Set(['p', 'div', 'section', 'article', 'main', 'h1', 'h2', 'h3', 'li', 'br', 'tr']);
function children(node: Node): Node[] { return 'childNodes' in node ? node.childNodes : []; }
function attribute(node: Node, name: string): string { return 'attrs' in node ? node.attrs.find(item => item.name === name)?.value ?? '' : ''; }
function tag(node: Node): string { return 'tagName' in node ? node.tagName : ''; }
function visibleText(node: Node, budget: { remaining: number }): string {
  const chunks: string[] = [], stack: { node: Node; end?: boolean }[] = [{ node }]; let visited = 0;
  while (stack.length) {
    const entry = stack.pop()!; if (++visited > 100000 || --budget.remaining < 0) throw new Error('MATERIALS_PAGE_TOO_LARGE');
    if (entry.end) { chunks.push('\n'); continue; }
    const current = entry.node, name = tag(current);
    if (ignored.has(name) || attribute(current, 'aria-hidden') === 'true' || 'attrs' in current && current.attrs.some(x => x.name === 'hidden')) continue;
    if ('value' in current && current.nodeName === '#text') chunks.push(current.value);
    else {
      if (block.has(name)) chunks.push('\n');
      if (block.has(name)) stack.push({ node: current, end: true });
      for (const child of [...children(current)].reverse()) stack.push({ node: child });
    }
  }
  return chunks.join('').replace(/\u00a0/gu, ' ').replace(/[\t ]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
}
function allNodes(document: Node): Node[] {
  const result: Node[] = [], stack = [document];
  while (stack.length) { const node = stack.pop()!; if (result.length >= 100000) throw new Error('MATERIALS_PAGE_TOO_LARGE'); result.push(node); const list=children(node); for (let index=list.length-1;index>=0;index--) stack.push(list[index]!); }
  return result;
}
function structuredPosting(value: unknown): Record<string, unknown> | null {
  const stack = [value]; let visited = 0;
  while (stack.length) {
    const row = stack.pop(); if (++visited > 10000) return null;
    if (!row || typeof row !== 'object') continue;
    if (Array.isArray(row)) { if (row.length > 10000) return null; for (const child of row) stack.push(child); continue; }
    const record = row as Record<string, unknown>, types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
    if (types.includes('JobPosting')) return record;
    for (const [key, child] of Object.entries(record)) if (key === '@graph' || key === 'mainEntity' || key === 'itemListElement' || key === 'item') stack.push(child);
  }
  return null;
}
function textValue(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function checkMarkupBudget(html: string): void {
  // Bound parse5's own synchronous work before building a deeply nested tree.
  let count=0; for(const _match of html.matchAll(/<[A-Za-z!]/gu)) { if(++count>20000) throw new Error('MATERIALS_PAGE_TOO_LARGE'); }
}
export function extractPublicJob(html: string, sourceUrl: string, finalUrl: string, capturedAt = Date.now()): { title: string; text: string; source: MaterialAcquisitionSource } {
  if (Buffer.byteLength(html, 'utf8') > 2 * 1024 * 1024) throw new Error('MATERIALS_PAGE_TOO_LARGE');
  checkMarkupBudget(html);
  if (isJobVerificationUrl(finalUrl)) throw new Error('MATERIALS_SITE_VERIFICATION');
  const document = parse(html), nodes = allNodes(document), budget = { remaining: 200000 };
  const titleNode = nodes.find(node => tag(node) === 'title'), pageTitle = titleNode ? visibleText(titleNode,budget).slice(0, 500) || null : null;
  const heading = nodes.find(node => tag(node) === 'h1'), headingText = heading ? visibleText(heading,budget) : '';
  const fullText = visibleText(document,budget);
  if (/安全验证|完成验证|验证码|请先登录|登录后查看|验证你的身份|verify you are human|access denied|captcha|sign in to continue|just a moment/iu.test((pageTitle ?? '')+'\n'+headingText)
    || /拖动滑块|扫码登录|请完成验证|访问过于频繁|verify you are human|checking your browser|enable javascript and cookies to continue/iu.test(fullText)) throw new Error('MATERIALS_SITE_VERIFICATION');
  let posting: Record<string, unknown> | null = null;
  for (const node of nodes) if (tag(node) === 'script' && attribute(node, 'type').toLowerCase() === 'application/ld+json') {
    const raw = children(node).map(child => 'value' in child ? child.value : '').join('');
    if (raw.length > 500000) continue;
    try { posting = structuredPosting(JSON.parse(raw)); } catch { /* A malformed optional block is not executable input. */ }
    if (posting) break;
  }
  let jobTitle = posting ? textValue(posting.title) : headingText;
  let text = '', metadata = '';
  if (posting) {
    const description = textValue(posting.description), organization = posting.hiringOrganization;
    const company = organization && typeof organization === 'object' && !Array.isArray(organization) ? textValue((organization as Record<string, unknown>).name) : '';
    const location = posting.jobLocation, locationRow = Array.isArray(location) ? location[0] : location;
    const address = locationRow && typeof locationRow === 'object' ? (locationRow as Record<string, unknown>).address : null;
    const locality = address && typeof address === 'object' ? ['addressRegion', 'addressLocality', 'streetAddress'].map(key => textValue((address as Record<string, unknown>)[key])).filter(Boolean).join(' ') : '';
    metadata = [jobTitle ? '岗位名称：' + jobTitle : '', company ? '公司名称：' + company : '', locality ? '工作地点：' + locality : ''].filter(Boolean).join('\n');
    checkMarkupBudget(description); text = visibleText(parseFragment(description),budget);
  }
  if (!text) {
    const candidates = nodes.filter(node => ['article', 'main'].includes(tag(node)) || /(?:^|\s)(?:job-sec-text|job-description|job-detail-section|job-detail-description|job-desc)(?:\s|$)/iu.test(attribute(node, 'class'))
      || ['jobDescription', 'job-description'].includes(attribute(node, 'id')));
    if(candidates.length>32) throw new Error('MATERIALS_PAGE_TOO_LARGE');
    const ranked = candidates.map(node => ({ text: visibleText(node,budget), priority: ['article', 'main'].includes(tag(node)) ? 1 : 2 }))
      .filter(row => row.text.length >= 30).sort((a, b) => b.priority - a.priority || b.text.length - a.text.length);
    text = ranked[0]?.text ?? '';
  }
  if (text.length < 30 || !posting && !/岗位职责|任职要求|职位描述|岗位要求|responsibilities|qualifications|requirements/iu.test(text)) throw new Error('MATERIALS_NO_JOB_TEXT');
  jobTitle = jobTitle.slice(0, 500).trim(); if (metadata) text = metadata + '\n\n' + text; else if (jobTitle && !text.includes(jobTitle)) text = '岗位名称：' + jobTitle + '\n\n' + text;
  text = text.replace(/\r\n?/gu, '\n');
  if (text.length > 200000 || text.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw new Error('MATERIALS_PAGE_TOO_LARGE');
  const source: MaterialAcquisitionSource = { method: 'public-html-v1', inputKind: 'url', sourceUrl: sanitizeJobSourceUrl(sourceUrl), finalUrl: sanitizeJobSourceUrl(finalUrl),
    pageTitle, capturedAt, contentHash: createHash('sha256').update(text).digest('hex'), originalFileId: null, originalHash: null, fields: recognizedFieldsFromText(text), ocr: null };
  return { title: jobTitle || source.fields.jobTitle || '岗位链接资料', text, source };
}
// Keep the node type import explicit for parse5 consumers without a DOM runtime.
export type ParsedJobElement = Element;
