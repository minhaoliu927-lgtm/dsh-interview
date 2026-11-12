import type { MaterialRecognizedFields } from '../contracts/material-source.ts';
/** Conservative verbatim field hints, never salary repair or semantic inference. */
export function recognizedFieldsFromText(text: string): MaterialRecognizedFields {
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const labelled = (labels: string[]) => lines.map(line => new RegExp(`^(?:${labels.join('|')})[：:]\\s*(.+)$`, 'u').exec(line)?.[1]?.trim()).find(Boolean) ?? null;
  const section = (labels: string[]) => {
    const start = lines.findIndex(line => new RegExp(`^(?:${labels.join('|')})[：:]?\\s*$`, 'u').test(line));
    if (start < 0) return labelled(labels);
    const following: string[] = [];
    for (const line of lines.slice(start + 1)) { if (/^(?:岗位职责|职位描述|工作职责|任职要求|岗位要求|职位要求|福利待遇|公司介绍)[：:]?$/u.test(line)) break; following.push(line); }
    const value = following.join('\n'); return value && text.includes(value) ? value : null;
  };
  const first = lines.find(line => line.length <= 100 && !/登录|验证|扫码|职位搜索|招聘平台/u.test(line)) ?? null;
  const salary = labelled(['薪资', '薪资范围', '薪酬', '工资']) ?? lines.find(line => /(?:\d[\d.,]*\s*[kKwW千万元]\s*[-—~至]\s*\d[\d.,]*\s*[kKwW千万元]|薪资面议)/u.test(line)) ?? null;
  const result: MaterialRecognizedFields = { jobTitle: labelled(['岗位名称', '职位名称', '招聘职位']) ?? first,
    company: labelled(['公司', '公司名称', '招聘公司']), salary, location: labelled(['工作地点', '工作地址', '地点', '城市']),
    responsibilities: section(['岗位职责', '工作职责', '职位描述']), requirements: section(['任职要求', '岗位要求', '职位要求']) };
  for (const key of Object.keys(result) as (keyof MaterialRecognizedFields)[]) {
    const value = result[key], maximum = ['responsibilities', 'requirements'].includes(key) ? 100000 : 500;
    if (value && (value.length > maximum || !text.includes(value))) result[key] = null;
  }
  return result;
}
