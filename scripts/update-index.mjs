import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Pin the already published, prebuilt package commit. Never point installs at a moving branch. */
export function createIndex(pkg, commit, publishTimestamp) {
  const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (pkg.name !== 'dsh-interview-desk' || !version.test(pkg.version) || typeof pkg.engines?.dsh !== 'string' || !pkg.engines.dsh) throw new Error('Unexpected package identity');
  if (!/^[a-f0-9]{40}$/.test(commit) || /^0+$/.test(commit)) throw new Error('Pass a full published Git commit');
  if (!Number.isSafeInteger(publishTimestamp) || publishTimestamp <= 0 || publishTimestamp >= 1e11) throw new Error('Pass a Unix publication timestamp in seconds');
  const repository = 'https://github.com/minhaoliu927-lgtm/dsh-interview-desk';
  return {
    format: 1,
    title: { zh: '职镜AI', en: 'Interview Desk' },
    description: { zh: '职镜AI 自有插件索引。使用固定版本的预构建包安装。', en: 'The Interview Desk plugin index, with prebuilt packages pinned to immutable Git commits.' },
    metadata: { categories: { career: { title: { zh: '求职与面试', en: 'Career and interviews' } } } },
    plugins: [{
      name: pkg.name,
      title: { zh: '职镜AI', en: 'Interview Desk' },
      description: { zh: pkg.description, en: 'A native DSH career workbench for personal materials, resume review, job fit, text and voice interviews, and reports. Development preview.' },
      author: 'minhaoliu927-lgtm', homepage: `${repository}#readme`, repository: { url: repository },
      metadata: { category: 'career', keywords: ['dsh-plugin', 'dsh-interview-desk', '职镜AI', '简历', '求职', '面试', 'resume', 'interview'] },
      versions: [{ version: pkg.version, publishTimestamp, source: { type: 'git', url: repository, commit }, engines: { dsh: pkg.engines.dsh } }],
    }],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [commit, timestamp, ...rest] = process.argv.slice(2);
  if (rest.length) throw new Error('Usage: node scripts/update-index.mjs COMMIT UNIX_SECONDS');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const index = createIndex(pkg, commit, Number(timestamp));
  await writeFile(new URL('../index.json', import.meta.url), JSON.stringify(index, null, 2) + '\n');
  console.log(JSON.stringify({ name: pkg.name, version: pkg.version, commit, publishTimestamp: Number(timestamp) }));
}
