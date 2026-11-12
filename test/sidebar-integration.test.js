import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({ absWorkingDir: root, entryPoints: ['client/sidebar-integration.jsx'], bundle: true, format: 'cjs', platform: 'browser', jsx: 'transform', external: ['react'], write: false });
const module = { exports: {} };
vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? ({ ...React, useState: () => [false, () => {}] }) : jsxRuntime });
const { mountBetterSidebar } = module.exports;
test('optional sidebar comes and goes without registering duplicate or unbound App instances', () => {
  let register, descriptor, disposed = 0, selected;
  const ctx = { inject(deps, install) { assert.deepEqual([...deps], ['betterSidebar']); register = install; }, get: name => name === 'layout' ? { selectPanel: value => { selected = value; } } : undefined };
  mountBetterSidebar(ctx, key => key);
  let cleanup;
  const inner = { get: () => ({ registerTab(value) { descriptor = value; return () => { disposed++; }; } }), effect: install => { cleanup = install(); } };
  register(inner); assert.equal(descriptor.id, 'dsh-interview-desk:workbench'); assert.equal(descriptor.single, true);
  const view = descriptor.component(); const button = view.props.children.find(row => row?.type === 'button');
  button.props.onClick(); assert.equal(selected, 'zhijing');
  cleanup(); selected = null; button.props.onClick(); assert.equal(selected, null); assert.equal(disposed, 1);
  register(inner); assert.equal(descriptor.single, true); cleanup(); assert.equal(disposed, 2);
});
test('missing optional sidebar and missing native navigation are safe', () => {
  mountBetterSidebar({}, key => key);
  let descriptor; mountBetterSidebar({ betterSidebar: { registerTab(value) { descriptor = value; } }, effect: install => install() }, key => key);
  assert.doesNotThrow(() => descriptor.component().props.children.find(row => row?.type === 'button').props.onClick());
});
