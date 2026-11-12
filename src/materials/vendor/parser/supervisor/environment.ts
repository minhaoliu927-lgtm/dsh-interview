import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, parse, sep } from 'node:path';

export function parserEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot || 'C:\\Windows', WINDIR: process.env.WINDIR || 'C:\\Windows' } : {}),
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    TEMP: directory, TMP: directory, TMPDIR: directory, HOME: directory, USERPROFILE: directory,
    APPDATA: directory, LOCALAPPDATA: directory, LANG: 'C.UTF-8', TZ: 'UTC', NO_COLOR: '1',
  };
}

/** Permit only this job, emitted parser code, installed dependencies and package metadata. */
export function parserNodeArguments(entry: string, directory: string, heapMb: number): string[] {
  let packageRoot = dirname(entry), found = false;
  const metadata: string[] = [];
  for (;;) {
    const manifest = join(packageRoot, 'package.json');
    if (existsSync(manifest)) {
      metadata.push(manifest);
      try { if (JSON.parse(readFileSync(manifest, 'utf8')).name === 'dsh-interview') { found = true; break; } } catch {}
    }
    if (packageRoot === parse(packageRoot).root) break;
    packageRoot = dirname(packageRoot);
  }
  if (!found || !entry.endsWith('.mjs')) throw new Error('PARSER_INVALID_CONFIG');
  for (let parent = dirname(packageRoot);; parent = dirname(parent)) {
    const manifest = join(parent, 'package.json');
    if (existsSync(manifest)) metadata.push(manifest);
    if (parent === dirname(parent)) break;
  }
  const roots = [directory, dirname(entry), ...metadata];
  const require = createRequire(join(packageRoot, 'package.json'));
  for (const dependency of ['pdfjs-dist/legacy/build/pdf.mjs', 'saxes', 'yauzl']) {
    const file = realpathSync(require.resolve(dependency));
    const parts = file.split(sep), index = parts.indexOf('node_modules');
    if (index < 0) throw new Error('PARSER_INVALID_CONFIG');
    roots.push(parts.slice(0, index + 1).join(sep));
  }
  const modules = join(packageRoot, 'node_modules');
  if (existsSync(modules)) roots.push(modules, realpathSync(modules));
  const args = [`--max-old-space-size=${heapMb}`, '--permission', '--allow-addons', '--disable-proto=throw'];
  for (const path of [...new Set(roots)].filter(existsSync)) args.push(`--allow-fs-read=${path}`);
  return args;
}
