import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePackedPath, auditText } from '../scripts/audit-package.mjs';
const windowsPath = (...parts) => parts.join(String.fromCharCode(92));
const posixPath = (...parts) => ['', ...parts].join('/');

test('package inventory permits generated parser runtime but excludes personal runtime and dependency trees', () => {
  assert.equal(validatePackedPath('src/materials/runtime/parser-child.mjs'), 'src/materials/runtime/parser-child.mjs');
  assert.equal(validatePackedPath('src/materials/vendor/parser/parse-document.ts'), 'src/materials/vendor/parser/parse-document.ts');
  for (const path of ['.runtime/zhijing/database/local.sqlite', 'runtime/profile/settings.json', 'node_modules/pdfjs-dist/LICENSE',
    'reference/final-round-client/index.js', 'files/private-resume.pdf', 'src/example.docx', 'src/recording.wav', 'assets/candidate.png', 'logs/provider.log', 'src/.env', 'release.zip']) {
    assert.throws(() => validatePackedPath(path), error => ['PRIVATE_PACKAGE_PATH', 'UNSAFE_PACKAGE_PATH'].includes(error.code));
  }
});

test('inventory paths cannot escape via Windows paths, backslashes or dot segments', () => {
  for (const path of ['../secret', 'src/../../private', '/absolute/file', ['C:', 'Users', 'person', 'data'].join('/'), 'src\\secret.json', 'src//file.js']) {
    assert.throws(() => validatePackedPath(path), { code: 'UNSAFE_PACKAGE_PATH' });
  }
});

test('text scan rejects private absolute paths but permits generic Windows OCR fallback', () => {
  auditText('worker.js', "const system = process.env.SystemRoot || 'C:\\\\Windows';");
  for (const text of [windowsPath('D:', 'private', 'resume.docx'), windowsPath('C:', 'Users', 'person', 'token').replaceAll(String.fromCharCode(92), String.fromCharCode(92).repeat(2)), posixPath('home', 'example', 'private'), posixPath('Users', 'person', 'data')]) {
    assert.throws(() => auditText('src/test.js', text), { code: 'LOCAL_PATH_IN_PACKAGE' });
  }
});

test('possible key detection reports only the owning filename, never the matched secret', () => {
  const candidate = 'sk-' + 'A'.repeat(32);
  assert.throws(() => auditText('src/config.js', candidate), error => error.code === 'POSSIBLE_SECRET_IN_PACKAGE' && !error.message.includes(candidate));
  auditText('src/voice/service.js', 'Authorization: `Bearer ${key}`');
  auditText('THIRD_PARTY_NOTICES.md', 'Source: https://github.com/deepseek-ai/deepseek-harness');
});

test('text scan detects dotted workspace keys and fine-grained GitHub tokens without leaking them', () => {
  // Build synthetic values at runtime so the public test file carries no token.
  const candidates = ['sk-' + 'ws-' + ['A'.repeat(10), 'B'.repeat(10), 'C'.repeat(10)].join('.'),
    'github_' + 'pat_' + 'A'.repeat(22) + '_' + 'B'.repeat(45)];
  for (const candidate of candidates) {
    assert.throws(() => auditText('src/config.js', candidate), error =>
      error.code === 'POSSIBLE_SECRET_IN_PACKAGE' && error.message.endsWith('src/config.js') && !error.message.includes(candidate));
  }
});

test('text scan rejects common service tokens and additional private key encodings', () => {
  const candidates = [
    'AKIA' + 'A'.repeat(16), 'ASIA' + 'B'.repeat(16), 'AIza' + 'C'.repeat(35),
    'xoxb-' + '1234567890-'.repeat(3), 'sk_' + 'live_' + 'D'.repeat(24), 'rk_' + 'test_' + 'E'.repeat(24),
    'eyJ' + 'F'.repeat(16) + '.' + 'G'.repeat(16) + '.' + 'H'.repeat(16),
    'Bearer ' + 'J'.repeat(32),
    ...['DSA', 'ENCRYPTED', 'OPENSSH', 'RSA', 'EC'].map(kind => ['-----BEGIN', kind, 'PRIVATE KEY-----'].join(' ')),
  ];
  for (const candidate of candidates) {
    assert.throws(() => auditText('src/config.js', candidate), error =>
      error.code === 'POSSIBLE_SECRET_IN_PACKAGE' && !error.message.includes(candidate));
  }
  auditText('src/voice/config.js', "const credentialRef = 'ZHIJING_REALTIME_API_KEY';");
  auditText('src/voice/provider.js', 'Authorization: `Bearer ${resolved.value}`');
});
