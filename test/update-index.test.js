import assert from 'node:assert/strict';
import test from 'node:test';
import { createIndex } from '../scripts/update-index.mjs';

const pkg = { name: 'dsh-interview-desk', version: '0.1.0-dev.6', description: '职镜AI 开发预览', engines: { dsh: '0.2.2-rc.1' } };
// Synthetic commit used only to exercise metadata validation; never an installation target.
const commit = '0123456789abcdef0123456789abcdef01234567';
const timestamp = Math.floor(Date.UTC(2026, 10, 12) / 1000);

test('index pins one package version to a full commit and keeps the verified Host requirement', () => {
  const index = createIndex(pkg, commit, timestamp);
  assert.equal(index.plugins.length, 1);
  const plugin = index.plugins[0];
  assert.equal(plugin.name, pkg.name);
  assert.equal(plugin.title.zh, '职镜AI');
  assert.deepEqual(plugin.versions, [{ version: pkg.version, publishTimestamp: timestamp,
    source: { type: 'git', url: 'https://github.com/minhaoliu927-lgtm/dsh-interview-desk', commit }, engines: { dsh: pkg.engines.dsh } }]);
});

test('moving refs, abbreviations, nonhex commits and the null commit cannot become install sources', () => {
  for (const value of ['main', 'prebuilt', 'v0.1.0-dev.6', commit.slice(0, 7), commit.slice(0, -1), `${commit}0`, commit.toUpperCase(), 'g'.repeat(40), '0'.repeat(40)]) {
    assert.throws(() => createIndex(pkg, value, timestamp), /commit/i, value);
  }
});

test('publication time rejects milliseconds, fractions and values outside the format-1 seconds range', () => {
  for (const value of [undefined, String(timestamp), NaN, Infinity, -1, 0, timestamp + 0.5, timestamp * 1000, 1e11, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => createIndex(pkg, commit, value), /timestamp|publication|seconds/i, String(value));
  }
});

test('renamed and malformed package identities cannot silently replace the indexed plugin', () => {
  for (const name of ['dsh-zhijing', 'dsh-interview', 'other-package', '', undefined]) {
    assert.throws(() => createIndex({ ...pkg, name }, commit, timestamp), /identity/i);
  }
  for (const version of ['latest', '^0.1.0', '01.2.3', '1.02.3', '1.2.03', '0.1.0-', '0.1.0-dev..6', '0.1.0-dev.06']) {
    assert.throws(() => createIndex({ ...pkg, version }, commit, timestamp), /identity|version/i, version);
  }
});
