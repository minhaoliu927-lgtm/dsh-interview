import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function registerCareerSkill(ctx) {
  const location = new URL('../skills/zhijing-career/SKILL.md', import.meta.url);
  const resourceBase = { kind: 'directory', path: fileURLToPath(new URL('../skills/zhijing-career/', import.meta.url)) };
  const candidate = { name: 'zhijing-career', description: 'Use 职镜AI tools to manage confirmed resume versions, compare a target job, revise a resume, and conduct evidence-based interview practice.',
    invocation: { modelInvocable: true, userInvocable: true }, provider: 'dsh-interview', source: 'bundled', resourceBase, rank: 600, locator: location };
  return ctx.skills.registerProvider(() => ({ name: 'dsh-interview', list: async () => [candidate],
    get: async () => ({ ...candidate, content: await readFile(location, 'utf8') }) }));
}
