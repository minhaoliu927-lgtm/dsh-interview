import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, lstat, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Build exclusively from the maintained source snapshot inside this plugin. */
export async function buildMaterialRuntime() {
  const vendor = join(root, 'src/materials/vendor');
  const outdir = join(root, 'src/materials/runtime');
  // This directory contains generated code only. Refuse a redirected output before replacing it.
  if (relative(root, resolve(outdir)).replaceAll('\\', '/') !== 'src/materials/runtime') throw new Error('Unexpected material build output');
  try {
    const existing = await lstat(outdir);
    const actual = await realpath(outdir);
    if (!existing.isDirectory() || existing.isSymbolicLink() || actual.toLowerCase() !== resolve(outdir).toLowerCase()) throw new Error('Redirected material build output');
    await rm(outdir, { recursive: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(outdir, { recursive: true });
  const host = await build({ absWorkingDir: root, entryPoints: [join(vendor, 'runtime.ts')], outfile: join(outdir, 'index.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', metafile: true, logLevel: 'warning' });
  const child = await build({ absWorkingDir: root, entryPoints: { 'parser-child': join(vendor, 'parser/parser-child.ts') }, outdir,
    bundle: true, splitting: true, chunkNames: 'child-chunks/[name]-[hash]', outExtension: { '.js': '.mjs' },
    // Keep package paths stable for pnpm's isolated and hoisted layouts. The
    // resolved store path otherwise leaks into comments, metadata and hashes.
    preserveSymlinks: true,
    platform: 'node', format: 'esm', target: 'node24', external: ['pdfjs-dist/*', 'saxes', 'yauzl'], metafile: true, logLevel: 'warning' });
  const entry = Object.entries(child.metafile.outputs).find(([, value]) => value.entryPoint?.endsWith('parser/parser-child.ts'));
  if (!entry) throw new Error('Parser child entry missing');
  const visited = new Set();
  const audit = key => {
    if (visited.has(key)) return; visited.add(key);
    for (const dependency of child.metafile.outputs[key].imports) {
      if (dependency.kind === 'dynamic-import') continue;
      if (/^(?:pdfjs-dist(?:\/|$)|saxes$|yauzl$)/u.test(dependency.path)) throw new Error('Parser imports precede capability guard');
      if (!dependency.external) audit(dependency.path);
    }
  };
  audit(entry[0]);
  await mkdir(join(outdir, 'supervisor'), { recursive: true });
  for (const name of ['windows-job.cs', 'windows-job.ps1']) await copyFile(join(vendor, 'parser/supervisor', name), join(outdir, 'supervisor', name));
  await copyFile(join(vendor, 'acquisition/windows-ocr.ps1'), join(outdir, 'windows-ocr.ps1'));
  const inputs = [...new Set([...Object.keys(host.metafile.inputs), ...Object.keys(child.metafile.inputs)])];
  if (inputs.some(path => /(?:^|[/\\])(?:reference|fixtures|test)(?:[/\\]|$)/u.test(path))) throw new Error('Material runtime contains nonproduction inputs');
  await writeFile(join(outdir, 'build-manifest.json'), `${JSON.stringify({ schemaVersion: 1, inputs: inputs.sort(), staticChildOutputs: [...visited].map(path => relative(root, resolve(root, path)).replaceAll('\\', '/')) }, null, 2)}\n`);
  return outdir;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildMaterialRuntime(); console.log('Built material parser, public URL import and Windows OCR from plugin-owned source');
}
