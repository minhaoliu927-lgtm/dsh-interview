import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fonts = {
  'assets/fonts/NotoSansCJKsc-Regular.otf': '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b',
  'assets/fonts/Noto-CJK-LICENSE.txt': '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2',
};
const brandAssets = {
  'assets/brand/logo-black.svg': 'd7c88cc217272f60d339db40826d7ed1272e298c606c493e13d016645d7b306f',
  'assets/brand/logo-white.svg': '3a24e5711198b26077c318aed2ec54a435c5eb799ea0768204380177ee020e9e',
};
const dependencyLicenses = {
  '@deepseek-ai/schemastery': ['3.19.0', 'MIT'], ws: ['8.22.1', 'MIT'],
  '@sinclair/typebox': ['0.34.49', 'MIT'], 'pdfjs-dist': ['6.1.200', 'Apache-2.0'], saxes: ['6.0.0', 'ISC'],
  yauzl: ['3.4.0', 'MIT'], parse5: ['8.0.0', 'MIT'], docx: ['9.5.1', 'MIT'], 'pdf-lib': ['1.17.1', 'MIT'], '@pdf-lib/fontkit': ['1.1.1', 'MIT'],
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const error = (code, detail) => { throw Object.assign(new Error(`${code}: ${detail}`), { code }); };

/** Reject private artifacts even when a future files list accidentally includes them. */
export function validatePackedPath(input) {
  if (typeof input !== 'string' || !input || input.includes('\\') || isAbsolute(input) || /^[a-z]:/i.test(input)
    || input.split('/').some(part => !part || part === '.' || part === '..')) error('UNSAFE_PACKAGE_PATH', String(input));
  const parts = input.toLowerCase().split('/');
  if (parts.some(part => ['.git', '.runtime', '.dsh', 'node_modules', 'reference', 'legacy-zhijing', 'final-round-client', 'final-round-desktop-restored',
    'credentials', 'sessions', 'cache', 'logs', 'crash-dumps', 'personal-data', 'userdata'].includes(part)) || parts[0] === 'files') error('PRIVATE_PACKAGE_PATH', input);
  if (parts.includes('runtime') && input !== 'src/materials/runtime' && !input.startsWith('src/materials/runtime/')) error('PRIVATE_PACKAGE_PATH', input);
  if (/(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pnpmfile\..*|id_rsa|id_ed25519|credentials\.json)$/i.test(input)
    || /\.(?:sqlite(?:3)?(?:-wal|-shm)?|db|log|jsonl|pem|pfx|key|dmp|tgz|zip|exe|dll|pdf|docx?|png|jpe?g|webp|wav|mp3|mp4|webm)$/i.test(input)) error('PRIVATE_PACKAGE_PATH', input);
  return input;
}

/** Check text contents without printing a matched path or possible credential. */
export function auditText(path, text) {
  // Generic Windows system-directory fallback is necessary for the hidden OCR worker.
  const withoutSystemDefault = text.replace(/C:(?:\\{1,4}|\/)Windows\b/g, 'WINDOWS_SYSTEM_DIRECTORY');
  if (/(?<![A-Za-z0-9])[A-Za-z]:(?:\\{1,4}|\/)|\/(?:Users|home|mnt)\/[^\s"'<>]+/.test(withoutSystemDefault)) error('LOCAL_PATH_IN_PACKAGE', path);
  const possibleSecrets = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
    // Workspace keys can contain dots; a prefix-only alphabet would miss them.
    /\bsk-[A-Za-z0-9_.-]{24,}/,
    /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{30,}/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\bAIza[A-Za-z0-9_-]{32,}/,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}/,
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
    /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/,
    /\bBearer\s+[A-Za-z0-9_.+\/=\-]{24,}/,
  ];
  if (possibleSecrets.some(pattern => pattern.test(text))) error('POSSIBLE_SECRET_IN_PACKAGE', path);
}

async function collect(root, selected) {
  const files = new Set();
  async function visit(name) {
    validatePackedPath(name);
    const absolute = join(root, ...name.split('/'));
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) error('SYMLINK_IN_PACKAGE', name);
    const actual = await realpath(absolute);
    const inside = relative(root, actual);
    if (inside.startsWith('..') || isAbsolute(inside)) error('OUTSIDE_PACKAGE', name);
    if (stat.isDirectory()) {
      for (const item of (await readdir(absolute)).sort()) await visit(`${name}/${item}`);
    } else if (stat.isFile()) files.add(name);
    else error('SPECIAL_FILE_IN_PACKAGE', name);
  }
  for (const name of selected) await visit(name);
  return [...files].sort();
}

/** Audit the npm files whitelist, or an actual npm pack --dry-run file inventory supplied by the caller. */
export async function auditPackage({ root = packageRoot, packFiles, checkInstalledDependencies = true } = {}) {
  root = await realpath(root);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'dsh-interview' || pkg.license !== 'MIT') error('PACKAGE_IDENTITY', 'Expected dsh-interview with an original-code MIT license');
  if (!Array.isArray(pkg.files) || pkg.files.some(item => typeof item !== 'string' || /[*?]/.test(item))) error('UNBOUNDED_PACKAGE_FILES', 'Use explicit package directories and files');
  if (pkg.bundleDependencies === true || pkg.bundledDependencies === true || pkg.bundleDependencies?.length || pkg.bundledDependencies?.length) error('UNREVIEWED_BUNDLED_DEPENDENCIES', 'Dependency trees require a separate license inventory');
  const paths = await collect(root, packFiles ?? [...new Set([...pkg.files, 'package.json', 'LICENSE', 'README.md'])]);
  const required = ['package.json', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'src/host.js', 'dist/client.js', 'cordis.patch.yml', 'icon.svg',
    'src/materials/runtime/index.mjs', 'src/materials/runtime/parser-child.mjs', 'src/materials/runtime/windows-ocr.ps1',
    'src/materials/runtime/supervisor/windows-job.ps1', 'src/materials/runtime/supervisor/windows-job.cs',
    'src/materials/vendor/IMPORT_MANIFEST.json', 'src/materials/vendor/README.md', ...Object.keys(fonts), ...Object.keys(brandAssets)];
  for (const path of required) if (!paths.includes(path)) error('MISSING_PACKAGE_FILE', path);
  if (!paths.some(path => path.startsWith('skills/') && path.endsWith('/SKILL.md'))) error('MISSING_PACKAGE_FILE', 'Bundled skill');
  if (!paths.includes('locale/zh.json') || !paths.includes('locale/en.json')) error('MISSING_PACKAGE_FILE', 'Localized plugin metadata');
  const inventory = [];
  for (const path of paths) {
    if (path.startsWith('assets/') && !Object.hasOwn(fonts, path) && !Object.hasOwn(brandAssets, path)) error('UNREVIEWED_PACKAGE_ASSET', path);
    const bytes = await readFile(join(root, ...path.split('/')));
    const hash = sha256(bytes);
    if (fonts[path] && hash !== fonts[path]) error('FONT_INTEGRITY', path);
    if (brandAssets[path] && hash !== brandAssets[path]) error('BRAND_ASSET_INTEGRITY', path);
    if (/\.(?:[cm]?js|jsx|ts|tsx|json|md|ya?ml|txt|svg|css|ps1|cs)$/.test(path) || path === 'LICENSE') auditText(path, bytes.toString('utf8'));
    inventory.push({ path, bytes: bytes.length, sha256: hash });
  }
  const notices = await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const copyright of ['Copyright (c) 2026 DeepSeek', 'Copyright (c) 2026 woniuniuniu (蜗牛的科技笔记)', 'Copyright (c) 2017-2026 Haydn Paterson', 'SIL Open Font License 1.1']) {
    if (!notices.includes(copyright)) error('MISSING_LICENSE_NOTICE', copyright);
  }
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    const expected = dependencyLicenses[name];
    if (!expected || expected[0] !== version || !notices.includes(`| \`${name}\` | ${version} | ${expected[1]} |`)) error('UNREVIEWED_DEPENDENCY', name);
    if (checkInstalledDependencies) {
      const installed = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
      if (installed.version !== version || installed.license !== expected[1]) error('DEPENDENCY_LICENSE_MISMATCH', name);
    }
  }
  const sourceManifest = JSON.parse(await readFile(join(root, 'src/materials/vendor/IMPORT_MANIFEST.json'), 'utf8'));
  if (!sourceManifest.length || sourceManifest.some(row => !/^[a-f0-9]{64}$/.test(row.sha256) || /(^|\/)reference\//.test(row.source)
    || !/^(?:packages\/(?:document-parser|domain|contracts)\/|apps\/desktop\/src\/main\/acquisition\/)/.test(row.source))) error('UNREVIEWED_VENDOR_SOURCE', 'Material source manifest');
  const built = JSON.parse(await readFile(join(root, 'src/materials/runtime/build-manifest.json'), 'utf8'));
  for (const input of built.inputs) {
    if (!input.startsWith('src/materials/vendor/') && !input.includes('/@sinclair/typebox/')) error('UNREVIEWED_BUNDLE_INPUT', input);
  }
  return { name: pkg.name, version: pkg.version, fileCount: inventory.length, bytes: inventory.reduce((sum, file) => sum + file.bytes, 0),
    inventorySha256: sha256(JSON.stringify(inventory)), externalDependencies: pkg.dependencies, files: inventory };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const at = process.argv.indexOf('--packlist');
    const raw = at >= 0 ? JSON.parse(await readFile(process.argv[at + 1], 'utf8')) : undefined;
    const packFiles = raw ? (Array.isArray(raw) && raw[0]?.files ? raw[0].files : raw.files ?? raw).map(item => typeof item === 'string' ? item : item.path) : undefined;
    const result = await auditPackage({ packFiles });
    console.log(JSON.stringify(process.argv.includes('--json') ? result : { ...result, files: undefined }, null, 2));
  } catch (failure) { console.error(failure.message); process.exitCode = 1; }
}
