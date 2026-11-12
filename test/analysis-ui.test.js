import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { en } from '../locale/dictionaries.js';

const require = createRequire(import.meta.url), React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const built = await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['client/analysis.jsx'],
  bundle: true, format: 'cjs', platform: 'browser', external: ['react'], write: false });
function load(react = React) {
  const module = { exports: {} };
  vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : require(name), console });
  return module.exports;
}
const ui = load();
const t = (key, params = {}) => String(en[key] || key).replace(/\{([^}]+)\}/g, (_match, name) => params[name] ?? name);
const plain = value => JSON.parse(JSON.stringify(value));
const fixture = () => {
  const base = { id: 'v1', materialId: 'm1', revision: 1, confirmed: true, text: '项目甲\r\n改进😀流程\r\n保留原文' };
  const saved = { id: 'v4', materialId: 'm1', revision: 4, confirmed: false, text: 'Saved immutable version' };
  const rewrite = { id: 'rw1', goalId: 'g1', materialId: 'm1', versionId: base.id, fullText: 'Complete proposal', acceptances: [],
    items: [{ id: 'a', before: 'First', after: 'First changed', reason: 'Clarify the first part' }, { id: 'b', before: 'Second', after: 'Second changed', reason: 'Clarify the second part' }] };
  const state = { materials: [{ id: 'm1', title: 'My immutable resume', kind: 'resume', versions: [saved, base] },
    { id: 'jm1', title: 'Job', kind: 'job', versions: [{ id: 'j1', confirmed: true, text: 'Job description' }] }], rewrites: [rewrite], assessments: [] };
  return { base, saved, rewrite, state, goal: { id: 'g1', title: 'Data analyst', materialLinks: [{ versionId: 'j1' }] } };
};

// Invoke actual JSX handlers with deterministic hook state. Static React rendering
// below separately checks DOM semantics; this harness is not browser/device QA.
function harness(name, initialProps) {
  const slots = []; let cursor = 0, props = initialProps;
  const hooks = { ...React,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useId() { return `analysis-test-${cursor++}`; },
  };
  const Component = load(hooks)[name];
  return { render(next = {}) { props = { ...props, ...next }; cursor = 0; return Component(props); } };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!React.isValidElement(tree)) return [];
  return [tree, ...nodes(tree.props.children)];
}
const find = (tree, predicate) => { const value = nodes(tree).find(predicate); assert.ok(value, 'Expected control exists'); return value; };
const button = (tree, key) => find(tree, row => row.props.children === t(key) && (row.type === 'button' || row.type?.name === 'Button'));
const sourceArea = tree => find(tree, row => row.type === 'textarea' && row.props.readOnly);
const instructionsArea = tree => find(tree, row => row.type === 'textarea' && row.props.maxLength === 10000);
const settle = () => new Promise(resolve => setImmediate(resolve));

test('source selection preserves exact CRLF and Unicode offsets and rejects another version or modified text', () => {
  const { base } = fixture(), normalized = base.text.replace(/\r\n?/g, '\n');
  const start = normalized.indexOf('改进'), end = normalized.indexOf('保留');
  const selection = { versionId: base.id, value: normalized, start, end };
  const actual = ui.selectedResumePassage(base, selection);
  assert.equal(actual.text, '改进😀流程\r\n'); assert.equal(base.text.slice(actual.start, actual.end), actual.text);
  for (const patch of [{ versionId: 'other' }, { value: 'different' }, { start: -1 }, { end: 999 }, { end: start }, { start: 1.1 }])
    assert.equal(ui.selectedResumePassage(base, { ...selection, ...patch }), null);
  assert.equal(ui.selectedResumePassage(null, selection), null);
  assert.equal(ui.selectedResumePassage({ id: 'blank', text: ' \r\n' }, { versionId: 'blank', value: ' \n', start: 0, end: 2 }), null);
});

test('keyboard source selection only fills the retained draft; explicit submit calls the model once', async () => {
  const { state, goal, base } = fixture(); let draft = { instructions: 'Keep my original facts.' }, finish; const actions = [];
  const h = harness('Analysis', { state, goal, tab: 'rewrite', selectedVersion: base.id, t, draft,
    onDraftChange: next => { draft = next; }, onAction: (...args) => { actions.push(args); return new Promise(resolve => { finish = resolve; }); } });
  let tree = h.render();
  assert.equal(button(tree, 'rewriteUseSelection').props.disabled, true);
  const source = sourceArea(tree), start = source.props.value.indexOf('改进');
  source.props.onKeyUp({ currentTarget: { value: source.props.value, selectionStart: start, selectionEnd: source.props.value.length } });
  tree = h.render(); button(tree, 'rewriteUseSelection').props.onClick();
  assert.equal(actions.length, 0); assert.ok(draft.instructions.includes('改进😀流程\r\n保留原文')); assert.match(draft.instructions, /^Keep my original facts\./);
  tree = h.render({ draft });
  assert.equal(instructionsArea(tree).props.value, draft.instructions);
  assert.ok(nodes(tree).some(row => row.props.role === 'status' && row.props.children === t('rewriteSelectionAdded')));
  const form = find(tree, row => row.type === 'form');
  form.props.onSubmit({ preventDefault() {} }); form.props.onSubmit({ preventDefault() {} });
  assert.equal(actions.length, 1); assert.equal(actions[0][0], 'rewrite.run'); assert.equal(actions[0][1].versionId, base.id);
  assert.equal(actions[0][1].instructions, draft.instructions); finish(); await settle();
});

test('source selection is unavailable after a version switch and oversized passages are never silently truncated', () => {
  const { state, goal, base } = fixture(); let writes = 0;
  const h = harness('Analysis', { state, goal, tab: 'rewrite', selectedVersion: base.id, t, draft: { instructions: 'x'.repeat(9998) }, onDraftChange: () => writes++ });
  let tree = h.render(), source = sourceArea(tree);
  source.props.onSelect({ currentTarget: { value: source.props.value, selectionStart: 0, selectionEnd: 5 } });
  tree = h.render(); assert.equal(button(tree, 'rewriteUseSelection').props.disabled, true);
  button(tree, 'rewriteUseSelection').props.onClick(); assert.equal(writes, 0);
  assert.ok(nodes(tree).some(row => row.props.role === 'status' && row.props.children === t('rewriteSelectionTooLong')));
  tree = h.render({ selectedVersion: 'v4', draft: {} }); assert.equal(button(tree, 'rewriteUseSelection').props.disabled, true);
});

test('controlled instruction and item drafts survive remount, including choosing no proposed changes', () => {
  const { state, goal, base, rewrite } = fixture(); let draft = { instructions: 'Retain this draft', rewrites: { rw1: { selectedIds: ['b'] } } };
  const props = { state, goal, selectedVersion: base.id, tab: 'rewrite', t, draft, onDraftChange: next => { draft = next; } };
  const tree = harness('Analysis', props).render();
  const result = find(tree, row => row.type?.name === 'RewriteResult');
  result.props.onDraftChange({ selectedIds: [] });
  assert.equal(draft.instructions, 'Retain this draft'); assert.deepEqual(plain(draft.rewrites.rw1.selectedIds), []);
  const remounted = harness('Analysis', { ...props, draft }).render();
  assert.equal(instructionsArea(remounted).props.value, 'Retain this draft');
  const rendered = renderToStaticMarkup(React.createElement(ui.RewriteResult, { rewrite, state, selectedVersion: base.id, t, draft: draft.rewrites.rw1 }));
  assert.doesNotMatch(rendered, /checked=""/); assert.match(rendered, /disabled=""[^>]*>Accept selected changes/);
});

test('rapid item toggles use the newest draft rather than reviving an unchecked item', () => {
  const { state, base, rewrite } = fixture(); let draft;
  const tree = harness('RewriteResult', { rewrite, state, selectedVersion: base.id, t, onDraftChange: next => { draft = next; } }).render();
  const boxes = nodes(tree).filter(row => row.type === 'input' && row.props.type === 'checkbox');
  boxes[0].props.onChange({ target: { checked: false } }); boxes[1].props.onChange({ target: { checked: false } });
  assert.deepEqual(plain(draft.selectedIds), []);
});

test('only an actual acceptance result reveals the exact saved version and review/base navigation cannot delete data', async () => {
  const { state, base, saved, rewrite } = fixture(); const selections = [], reviews = [], calls = []; let draft = {}, finish;
  const h = harness('RewriteResult', { rewrite, state, selectedVersion: base.id, t, draft, onDraftChange: next => { draft = next; },
    onSelectVersion: id => selections.push(id), onReviewVersion: id => reviews.push(id),
    onAccept: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); } });
  let tree = h.render(); assert.equal(nodes(tree).some(row => row.props.children === t('rewriteViewNewVersion')), false);
  button(tree, 'acceptChanges').props.onClick(); button(tree, 'acceptChanges').props.onClick(); assert.equal(calls.length, 1);
  finish({ rewriteId: rewrite.id, version: saved, itemIds: ['a', 'b'] }); await settle();
  assert.deepEqual(plain(draft.savedVersion), { id: 'v4', revision: 4, materialId: 'm1' });
  tree = h.render({ draft }); button(tree, 'rewriteViewNewVersion').props.onClick();
  assert.deepEqual(reviews, ['v4']); assert.deepEqual(selections, []); assert.equal(calls.length, 1);
  tree = h.render({ selectedVersion: saved.id }); button(tree, 'rewriteReturnOriginalVersion').props.onClick();
  assert.deepEqual(selections, ['v1']); assert.equal(calls.length, 1); assert.equal(state.materials[0].versions.length, 2);
  const html = renderToStaticMarkup(React.createElement(ui.RewriteResult, { rewrite, state, selectedVersion: saved.id, t, draft, onSelectVersion() {} }));
  assert.ok(html.includes(t('rewriteSavedVersion', { version: t('version', { number: 4 }) })));
  assert.ok(html.includes(t('rewriteVersionSwitchNote')));
  for (const response of [undefined, {}, { rewriteId: 'other', version: saved }, { rewriteId: rewrite.id, version: base },
    { rewriteId: rewrite.id, version: { ...saved, materialId: 'foreign' } }]) assert.equal(ui.savedRewriteVersion(rewrite, response), null);
});

test('original and accepted versions find their proposal without crossing goals or masking a newer proposal', () => {
  const { state, rewrite } = fixture(); rewrite.acceptedVersionId = 'v4'; rewrite.acceptances = [{ versionId: 'v3', itemIds: ['a'] }];
  assert.equal(ui.rewriteForVersion(state, 'g1', 'v1').id, 'rw1'); assert.equal(ui.rewriteForVersion(state, 'g1', 'v3').id, 'rw1');
  assert.equal(ui.rewriteForVersion(state, 'g1', 'v4').id, 'rw1'); assert.equal(ui.rewriteForVersion(state, 'g2', 'v4'), undefined);
  assert.deepEqual(plain(ui.selectedRewriteItems(rewrite, undefined, 'v3')), ['a']);
  state.rewrites.push({ ...rewrite, id: 'next', versionId: 'v4', acceptedVersionId: null, acceptances: [] });
  assert.equal(ui.rewriteForVersion(state, 'g1', 'v4').id, 'next');
});

test('source textarea is labeled and read-only; absent, job and unconfirmed versions never enable generation', () => {
  const { state, goal, base } = fixture();
  const props = { state, goal, tab: 'rewrite', selectedVersion: base.id, t };
  const html = renderToStaticMarkup(React.createElement(ui.Analysis, props));
  assert.match(html, /readonly=""/); assert.match(html, /aria-describedby="[^"]+"/);
  assert.ok(html.includes('My immutable resume')); assert.ok(html.includes('Data analyst')); assert.ok(html.includes('Version 1'));
  assert.match(html, /<button type="button"[^>]*disabled=""[^>]*>[^<]+<\/button>/);
  for (const selectedVersion of ['', 'missing', 'j1', 'v4']) {
    const tree = harness('Analysis', { ...props, selectedVersion, onAction() { assert.fail('Invalid version generated output'); } }).render();
    assert.equal(button(tree, 'generateRewrite').props.disabled, true);
    find(tree, row => row.type === 'form').props.onSubmit({ preventDefault() {} });
    if (selectedVersion !== 'v4') assert.equal(nodes(tree).some(row => row.type === 'textarea' && row.props.readOnly), false);
  }
  const unconfirmed = renderToStaticMarkup(React.createElement(ui.Analysis, { ...props, selectedVersion: 'v4' }));
  assert.match(unconfirmed, /<option value="v4" selected="">/); assert.ok(unconfirmed.includes(t('reviewNote')));
});
