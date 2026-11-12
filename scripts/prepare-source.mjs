import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditText, validatePackedPath } from './audit-package.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestName = 'PUBLIC_SOURCE_MANIFEST.json';
const directories = ['src', 'client', 'scripts', 'test', 'skills', 'locale', 'assets'];
const rootFiles = ['.gitignore', '.npmignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'icon.svg', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md'];
const assetHashes = {
  'assets/brand/logo-black.svg': 'd7c88cc217272f60d339db40826d7ed1272e298c606c493e13d016645d7b306f',
  'assets/brand/logo-white.svg': '3a24e5711198b26077c318aed2ec54a435c5eb799ea0768204380177ee020e9e',
  'assets/fonts/NotoSansCJKsc-Regular.otf': '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b',
  'assets/fonts/Noto-CJK-LICENSE.txt': '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2',
};
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, detail) => { throw Object.assign(new Error(`${code}: ${detail}`), { code }); };
const inside = (parent, child) => { const name = relative(parent, child); return name === '' || (name !== '..' && !name.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(name)); };

function permitted(name) {
  validatePackedPath(name);
  if (name === 'src/materials/runtime' || name.startsWith('src/materials/runtime/')) fail('GENERATED_SOURCE_FILE', name);
  if (rootFiles.includes(name)) return;
  if (!directories.includes(name.split('/')[0]) || !/\.(?:[cm]?js|jsx|ts|tsx|json|md|ya?ml|svg|css|ps1|cs|otf|txt)$/.test(name)) fail('UNREVIEWED_SOURCE_FILE', name);
  if (name.startsWith('assets/') && !Object.hasOwn(assetHashes, name)) fail('UNREVIEWED_SOURCE_ASSET', name);
}

async function safeDirectory(directory, { create = false } = {}) {
  const absolute = resolve(directory);
  const parent = dirname(absolute);
  if (parent !== absolute) await safeDirectory(parent, { create });
  let stat;
  try { stat = await lstat(absolute); }
  catch (error) { if (error.code !== 'ENOENT' || !create) throw error; await mkdir(absolute); stat = await lstat(absolute); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || relative(absolute, await realpath(absolute)) !== '') fail('UNSAFE_SOURCE_DIRECTORY', 'A directory or ancestor is a link or has changed');
  return absolute;
}

async function list(directory, { all = false } = {}) {
  const files = [];
  const visit = async (name) => {
    // Runtime workers are regenerated from the maintained sources during build.
    if (!all && name === 'src/materials/runtime') return;
    validatePackedPath(name);
    const absolute = join(directory, ...name.split('/'));
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || !inside(directory, await realpath(absolute))) fail('UNSAFE_SOURCE_ENTRY', name);
    if (stat.isDirectory()) {
      for (const child of (await readdir(absolute)).sort()) await visit(`${name}/${child}`);
    } else if (stat.isFile() && stat.nlink === 1) { permitted(name); files.push(name); }
    else fail('UNSAFE_SOURCE_ENTRY', name);
  };
  const selected = all ? (await readdir(directory)).filter(name => name !== manifestName).sort() : [...rootFiles, ...directories];
  for (const name of selected) await visit(name);
  return files.sort();
}

async function record(directory, name) {
  const bytes = await readFile(join(directory, ...name.split('/')));
  const sha256 = hash(bytes);
  if (name.endsWith('.otf')) {
    if (assetHashes[name] !== sha256) fail('SOURCE_FONT_INTEGRITY', name);
  } else {
    auditText(name, bytes.toString('utf8'));
    if (assetHashes[name] && assetHashes[name] !== sha256) fail(name.startsWith('assets/fonts/') ? 'SOURCE_FONT_INTEGRITY' : 'SOURCE_ASSET_INTEGRITY', name);
  }
  return { bytes, entry: { path: name, bytes: bytes.length, sha256 } };
}

/** Copy only public, rebuildable plugin source into a new or empty directory. Never initialise Git or publish. */
export async function prepareSource({ out } = {}) {
  if (typeof out !== 'string' || !out.trim()) fail('SOURCE_OUTPUT_REQUIRED', 'Pass an explicit --out directory');
  const root = await safeDirectory(sourceRoot), output = resolve(out);
  if (inside(root, output) || inside(output, root)) fail('SOURCE_OUTPUT_OVERLAP', 'Output must be separate from the plugin source');
  await safeDirectory(output, { create: true });
  if ((await readdir(output)).length) fail('SOURCE_OUTPUT_NOT_EMPTY', 'Refusing to overwrite an existing directory');
  const inventory = [];
  for (const name of await list(root)) {
    const { bytes, entry } = await record(root, name);
    const target = join(output, ...name.split('/'));
    await safeDirectory(dirname(target), { create: true });
    await writeFile(target, bytes, { flag: 'wx' });
    inventory.push(entry);
  }
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = { schemaVersion: 1, name: pkg.name, version: pkg.version, license: pkg.license,
    inventorySha256: hash(JSON.stringify(inventory)), files: inventory };
  await writeFile(join(output, manifestName), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return verifySource(output);
}

/** Verify every copied byte and reject extra files, private trees, links and generated artifacts. */
export async function verifySource(directory) {
  const root = await safeDirectory(directory);
  const manifestPath = join(root, manifestName), stat = await lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) fail('SOURCE_MANIFEST_INVALID', manifestName);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.name !== 'dsh-interview' || manifest.license !== 'MIT' || !Array.isArray(manifest.files)) fail('SOURCE_MANIFEST_INVALID', manifestName);
  const files = await list(root, { all: true });
  if (JSON.stringify(files) !== JSON.stringify(manifest.files.map(row => row.path))) fail('SOURCE_INVENTORY_MISMATCH', 'Manifest and public file list differ');
  const inventory = [];
  for (const name of files) inventory.push((await record(root, name)).entry);
  if (JSON.stringify(inventory) !== JSON.stringify(manifest.files) || hash(JSON.stringify(inventory)) !== manifest.inventorySha256) fail('SOURCE_HASH_MISMATCH', 'A source file has changed');
  for (const name of [...rootFiles, ...Object.keys(assetHashes), 'client/index.jsx', 'scripts/build.mjs', 'scripts/vendor-parser.mjs', 'src/host.js']) {
    if (!files.includes(name)) fail('SOURCE_REQUIRED_FILE', name);
  }
  return { name: manifest.name, version: manifest.version, fileCount: files.length, bytes: inventory.reduce((sum, row) => sum + row.bytes, 0), inventorySha256: manifest.inventorySha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (argv.length !== 2 || !['--out', '--verify'].includes(argv[0])) fail('SOURCE_ARGUMENTS', 'Use --out NEW_DIRECTORY or --verify EXPORTED_DIRECTORY');
    console.log(JSON.stringify(await (argv[0] === '--out' ? prepareSource({ out: argv[1] }) : verifySource(argv[1])), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
