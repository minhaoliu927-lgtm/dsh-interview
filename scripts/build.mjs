import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
await fs.mkdir(path.join(root, 'dist'), { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['client/index.jsx'], outfile: 'dist/client.js', bundle: true,
  format: 'cjs', platform: 'browser', target: 'chrome120', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
  external: ['react'], loader: { '.css': 'text' }, minify: true, legalComments: 'inline',
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{const module={exports:{}};const exports=module.exports;` },
  footer: { js: 'return module.exports}})' },
});
const { buildMaterialRuntime } = await import('./vendor-parser.mjs');
await buildMaterialRuntime();
console.log('Built DSH Client and document workers.');
