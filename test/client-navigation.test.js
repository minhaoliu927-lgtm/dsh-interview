import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { en } from '../locale/dictionaries.js';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = fileURLToPath(new URL('../', import.meta.url));
async function compile(entry) {
  const result = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'browser', external: ['react'], loader: { '.css': 'text' }, write: false });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require, AbortController, setTimeout, clearTimeout, console });
  return module.exports;
}
const workbench = await compile('client/workbench.jsx');
const components = await compile('client/components.jsx');
const interview = await compile('client/interview.jsx');
const t = (key, params = {}) => String(en[key] || key).replace(/\{([^}]+)\}/g, (_match, name) => params[name] ?? name);
const fixture = () => ({ materials: [
  { id: 'resume', kind: 'resume', title: 'My resume', versions: [{ id: 'r2', revision: 2, confirmed: true }, { id: 'r1', revision: 1, confirmed: true }, { id: 'unconfirmed', revision: 3, confirmed: false }] },
  { id: 'job', kind: 'job', title: 'Role', versions: [{ id: 'j1', confirmed: true }] },
], reports: [] });

test('returning from personal material or another goal restores the exact chat, tab and resume without cross-goal selection', () => {
  let state = workbench.initialWorkbenchNavigation();
  const send = event => { state = workbench.workbenchNavigation(state, event); };
  send({ type: 'goal', goalId: 'A' });
  send({ type: 'version', value: 'r1' });
  send({ type: 'tab', value: 'fit' });
  send({ type: 'chat', goalId: 'A', sessionId: 'session-A' });
  send({ type: 'view', view: 'personal' });
  send({ type: 'goal', goalId: 'A' });
  assert.equal(state.view, 'chat'); assert.equal(state.sessionId, 'session-A');
  assert.equal(state.byGoal.A.tab, 'fit'); assert.equal(state.byGoal.A.versionId, 'r1');
  send({ type: 'goal', goalId: 'B' });
  assert.equal(state.sessionId, null); assert.equal(state.byGoal.B.versionId, '');
  send({ type: 'version', value: 'r2' });
  send({ type: 'chat', goalId: 'B', sessionId: 'session-B' });
  send({ type: 'goal', goalId: 'A' });
  assert.equal(state.sessionId, 'session-A'); assert.equal(state.byGoal.A.versionId, 'r1');
  assert.equal(state.byGoal.B.sessionId, 'session-B'); assert.equal(state.byGoal.B.versionId, 'r2');
  // The goal button remains a way back from its chat to its tabs.
  send({ type: 'goal', goalId: 'A' });
  assert.equal(state.view, 'goal'); assert.equal(state.byGoal.A.tab, 'fit');
  assert.equal(state.sessionId, 'session-A');
});

test('home and existing chat navigation never replace a goal resume with another conversation context', () => {
  let state = workbench.initialWorkbenchNavigation();
  for (const event of [{ type: 'goal', goalId: 'A' }, { type: 'version', value: 'r1' },
    { type: 'chat', goalId: 'A', sessionId: 'existing-frozen-session' }, { type: 'view', view: 'home' },
    { type: 'chat', sessionId: 'ungrouped-session' }, { type: 'goal', goalId: 'A' }]) state = workbench.workbenchNavigation(state, event);
  assert.equal(state.sessionId, 'existing-frozen-session'); assert.equal(state.byGoal.A.versionId, 'r1');
  assert.equal(state.view, 'chat');
});

test('cancelled form drafts and unanswered interview text survive navigation and stay scoped to goal, source version and question', () => {
  const sourceA = { material: { id: 'm1' }, version: { id: 'v1' } };
  const sourceB = { material: { id: 'm1' }, version: { id: 'v2' } };
  const keys = [workbench.materialDraftKey(sourceA), workbench.materialDraftKey(sourceB),
    workbench.materialDraftKey({ initialKind: 'job', goalId: 'A' }), workbench.materialDraftKey({ initialKind: 'job', goalId: 'B' }),
    'interview:A', 'answer:interview-1:q1', 'answer:interview-1:q2'];
  assert.equal(new Set(keys).size, keys.length);
  let state = workbench.initialWorkbenchNavigation();
  keys.forEach((key, index) => { state = workbench.workbenchNavigation(state, { type: 'draft', key, value: { text: `draft-${index}` } }); });
  for (const event of [{ type: 'view', view: 'personal' }, { type: 'goal', goalId: 'A' }, { type: 'goal', goalId: 'B' }, { type: 'view', view: 'home' }]) state = workbench.workbenchNavigation(state, event);
  keys.forEach((key, index) => assert.equal(state.drafts[key].text, `draft-${index}`));
  state = workbench.workbenchNavigation(state, { type: 'draft', key: keys[0], value: undefined });
  assert.equal(state.drafts[keys[0]], undefined); assert.equal(state.drafts[keys[1]].text, 'draft-1');
});

test('interview inherits the selected confirmed immutable resume and retains cancelled language/count preferences', () => {
  const state = fixture();
  const draft = interview.interviewFormDraft(state, 'r1', { versionId: 'r2', language: 'en', questionCount: 3 });
  assert.equal(draft.versionId, 'r1'); assert.equal(draft.language, 'en'); assert.equal(draft.questionCount, 3);
  assert.equal(interview.interviewFormDraft(state, 'unconfirmed').versionId, '');
  assert.equal(interview.interviewFormDraft(state, 'j1').versionId, '');
  assert.equal(interview.interviewFormDraft(state, 'deleted', { versionId: 'deleted' }).versionId, '');
  const html = renderToStaticMarkup(React.createElement(interview.InterviewForm, {
    state, goal: { id: 'A', materialLinks: [{ versionId: 'j1' }] }, t, selectedVersion: 'r1',
  }));
  assert.match(html, /<option value="r1" selected="">/);
  assert.doesNotMatch(html, /<option value="r2" selected="">/);
});

test('reopened upload uses its retained File without pretending to restore the browser file input', () => {
  const html = renderToStaticMarkup(React.createElement(components.MaterialForm, { t,
    draft: { mode: 'file', kind: 'resume', title: 'Resume draft', text: '', url: '', file: { name: 'resume.pdf' } },
  }));
  assert.match(html, /value="Resume draft"/); assert.match(html, /<span>resume.pdf<\/span>/);
  const fileInput = html.match(/<input[^>]*type="file"[^>]*>/)?.[0];
  assert.ok(fileInput); assert.doesNotMatch(fileInput, /required|value=/);
});

test('returning to a question restores its draft without attaching it to the next question', () => {
  const state = fixture();
  const data = { id: 'i1', currentQuestionId: 'q1', status: 'active', language: 'en', questions: [{ id: 'q1', text: 'First question' }, { id: 'q2', text: 'Next question' }] };
  const props = { state, interview: data, t, answerDraft: { questionId: 'q1', text: 'My unfinished example', speechDraft: null } };
  assert.match(renderToStaticMarkup(React.createElement(interview.Interview, props)), /My unfinished example/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(interview.Interview, { ...props, interview: { ...data, currentQuestionId: 'q2' } })), /My unfinished example/);
});

test('rapid duplicate submission is ignored and a failed request can be retried', async () => {
  const guard = components.createSubmissionGuard();
  let finish, calls = 0;
  const request = guard(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  assert.equal(await guard(() => { calls++; }), undefined); assert.equal(calls, 1);
  finish('saved'); assert.equal(await request, 'saved');
  await assert.rejects(guard(async () => { calls++; throw new Error('network'); }), /network/);
  assert.equal(await guard(async () => { calls++; return 'retry-saved'; }), 'retry-saved'); assert.equal(calls, 3);
});
