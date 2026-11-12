import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../assets/fonts/', import.meta.url);
await fs.mkdir(root, { recursive: true });
const entries = [
  ['NotoSansCJKsc-Regular.otf', 'OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf', 'dc15562470b4f842321894787a0d066879ccff8b'],
  ['Noto-CJK-LICENSE.txt', 'LICENSE', 'd952d62c065f3f35fb83a173496e90b21525aef3'],
];
for (const [name, remote, gitBlob] of entries) {
  const url = `https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/${remote}`;
  let bytes;
  if (process.argv.includes('--verify-only')) bytes = await fs.readFile(new URL(name, root));
  else {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Font download: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (actual !== gitBlob) throw new Error(`Font source changed: ${name}`);
  await fs.writeFile(new URL(name, root), bytes);
  console.log(`${name} ${bytes.length} bytes sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
}
