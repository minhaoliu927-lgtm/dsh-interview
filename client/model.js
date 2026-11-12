export const EMPTY_STATE = { materials: [], goals: [], conversations: [], assessments: [], rewrites: [], interviews: [], reports: [], runs: [] };

function createRequestId() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return `zhijing-${crypto.randomUUID()}`;
  // getRandomValues remains usable in browser contexts that do not expose
  // randomUUID. Never use a shared counter or predictable cross-tab identity.
  if (typeof crypto?.getRandomValues !== 'function') throw Object.assign(new Error('Secure request identity unavailable'), { code: 'CLIENT_CRYPTO_REQUIRED' });
  return `zhijing-${[...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

export function versionEntry(state, versionId) {
  for (const material of state.materials) {
    const version = material.versions.find(row => row.id === versionId);
    if (version) return { material, version };
  }
  return null;
}

export function resumeOptions(state) {
  return state.materials.filter(row => row.kind === 'resume').flatMap(material => material.versions
    .filter(version => version.confirmed)
    .map(version => ({ material, version })));
}

export function goalHasJob(state, goal) {
  return Boolean(goal?.materialLinks.some(link => {
    const entry = versionEntry(state, link.versionId);
    return entry?.material.kind === 'job' && entry.version.confirmed;
  }));
}

export function latestAssessment(state, versionId, goalId, kind = 'resume') {
  return state.assessments.find(row => row.versionId === versionId && row.kind === kind
    && (kind === 'resume' || row.goalId === goalId)) || null;
}

export function citationSource(state, sourceId) {
  const entry = versionEntry(state, sourceId);
  if (entry) return { title: entry.material.title, revision: entry.version.revision, text: entry.version.text };
  for (const interview of state.interviews) {
    const question = interview.questions.find(row => row.answer?.id === sourceId);
    if (question) return { title: question.text, text: question.answer.text };
  }
  return null;
}

export function quoteSegments(text, citation) {
  if (!citation?.quote) return { before: text, quote: '', after: '' };
  let start = citation.start, end = citation.end;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || text.slice(start, end) !== citation.quote) {
    start = text.indexOf(citation.quote);
    if (start < 0 || text.indexOf(citation.quote, start + 1) !== -1) return { before: text, quote: '', after: '' };
    end = start + citation.quote.length;
  }
  return { before: text.slice(0, start), quote: text.slice(start, end), after: text.slice(end) };
}

/**
 * Owns remote career facts and only this renderer's direct business requests.
 * operation selects the newest active task, otherwise the newest-started
 * terminal task; lastOperation retains that terminal receipt during concurrency.
 * saveAcknowledged=false means unknown, never proof that a write was undone.
 * Native perform(), reads and exports do not acquire direct task cancellation.
 */
export function createCareerClient(api, { intervalMs = 5000, schedule = setInterval, unschedule = clearInterval,
  now = Date.now, requestIdFactory = createRequestId, cancelTimeoutMs = 5000 } = {}) {
  let snapshot = { data: EMPTY_STATE, ready: false, loading: false, pending: 0, error: null,
    operation: null, operations: [], lastOperation: null };
  const listeners = new Set();
  const controllers = new Set();
  const tasks = new Map();
  const usedRequestIds = new Set();
  const separateReads = new Set(['state', 'conversation.context', 'material.get', 'material.source', 'material.original',
    'report.get', 'document.export', 'voice.catalog', 'realtime.catalog']);
  let sequence = 0, latestTerminal = null;
  let timer;
  let disposed = false;
  let refreshPromise;
  let mutationEpoch = 0;
  if (!Number.isInteger(cancelTimeoutMs) || cancelTimeoutMs < 10 || cancelTimeoutMs > 20_000) throw new Error('Invalid cancellation timeout');
  const abortError = () => Object.assign(new Error('Operation cancelled'), { name: 'AbortError', code: 'CANCELLED' });
  const aborted = error => error?.name === 'AbortError' || error?.code === 'CANCELLED' || error?.code === 'ABORT_ERR';
  const facts = task => task ? { action: task.action, requestId: task.requestId, startedAt: task.startedAt,
    status: task.status, canCancel: task.status === 'running' && !task.cancelRequested,
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(task.cancelState ? { cancelState: task.cancelState } : {}),
    ...(task.error ? { error: task.error } : {}),
    saveAcknowledged: task.saveAcknowledged } : null;
  const publish = patch => {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    for (const notify of [...listeners]) notify();
  };
  function publishTasks(patch = {}) {
    const active = [...tasks.values()].filter(task => task.status === 'running' || task.status === 'refreshing');
    const current = active.at(-1) ?? latestTerminal;
    publish({ ...patch, operation: facts(current), operations: active.map(facts), lastOperation: facts(latestTerminal) });
  }
  function terminal(task, status, failure) {
    task.status = status; task.finishedAt ??= now();
    if (failure) task.error = failure;
    if (!latestTerminal || task.sequence >= latestTerminal.sequence) latestTerminal = task;
    publishTasks();
  }
  async function tracked(operation) {
    if (disposed) throw new Error('Client disposed');
    const controller = new AbortController();
    controllers.add(controller);
    try { return await operation(controller.signal); }
    finally { controllers.delete(controller); }
  }
  async function refresh() {
    if (disposed) return;
    if (refreshPromise) return refreshPromise;
    const epoch = mutationEpoch;
    publish({ loading: !snapshot.ready });
    refreshPromise = tracked(signal => api.request('state', {}, { signal }))
      .then(data => { if (epoch === mutationEpoch) publish({ data, ready: true, error: null }); })
      .catch(error => { if (epoch === mutationEpoch && !aborted(error)) publish({ error }); })
      .finally(() => { refreshPromise = undefined; publish({ loading: false }); });
    return refreshPromise;
  }
  async function perform(operation) {
    mutationEpoch += 1;
    publish({ pending: snapshot.pending + 1, error: null });
    try {
      const result = await tracked(operation);
      if (refreshPromise) await refreshPromise;
      await refresh();
      return result;
    } catch (error) {
      if (error.name !== 'AbortError') publish({ error });
      throw error;
    } finally { publish({ pending: Math.max(0, snapshot.pending - 1) }); }
  }
  async function reconcile() {
    mutationEpoch += 1;
    if (refreshPromise) await refreshPromise;
    await refresh();
  }
  function waitForTask(task, operation) {
    const signal = task.controller.signal;
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(abortError()); };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      let promise;
      try { promise = Promise.resolve(operation(signal, task.requestId)); }
      catch (error) { signal.removeEventListener('abort', abort); reject(error); return; }
      promise.then(value => {
        signal.removeEventListener('abort', abort);
        if (task.cancelRequested) { if (!disposed) void reconcile(); reject(abortError()); }
        else resolve(value);
      }, error => {
        signal.removeEventListener('abort', abort);
        if (task.cancelRequested && !disposed) void reconcile();
        reject(error);
      });
    });
  }
  async function direct(action, operation) {
    if (disposed) throw new Error('Client disposed');
    const requestId = requestIdFactory();
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId) || usedRequestIds.has(requestId)) {
      throw Object.assign(new Error('Invalid or repeated request identity'), { code: 'INVALID_REQUEST_ID' });
    }
    usedRequestIds.add(requestId);
    const task = { action, requestId, sequence: ++sequence, startedAt: now(), status: 'running', saveAcknowledged: false,
      controller: new AbortController(), cancelRequested: false };
    tasks.set(requestId, task); controllers.add(task.controller); mutationEpoch += 1;
    publishTasks({ pending: snapshot.pending + 1, error: null });
    try {
      const result = await waitForTask(task, operation);
      if (task.cancelRequested || task.controller.signal.aborted) throw abortError();
      task.saveAcknowledged = true; task.status = 'refreshing'; publishTasks();
      await reconcile();
      terminal(task, 'succeeded');
      return result;
    } catch (error) {
      if (task.cancelRequested || aborted(error)) {
        terminal(task, 'cancelled'); throw abortError();
      }
      terminal(task, 'failed', error);
      if (snapshot.operation?.requestId === requestId) publish({ error });
      throw error;
    } finally {
      controllers.delete(task.controller); tasks.delete(requestId);
      publishTasks({ pending: Math.max(0, snapshot.pending - 1) });
    }
  }
  function cancelTask(task) {
    if (task.cancelPromise) return task.cancelPromise;
    if (task.status !== 'running') return Promise.resolve({ cancelled: false });
    task.cancelRequested = true; task.cancelState = 'requested'; mutationEpoch += 1;
    task.controller.abort(); terminal(task, 'cancelled');
    // The cancellation request has a separate signal: reusing the aborted task
    // signal would prevent the Host from receiving its exact request identity.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), cancelTimeoutMs);
    task.cancelPromise = new Promise(resolve => {
      let settled = false;
      const finish = (cancelState, hostCancelled) => {
        if (settled) return;
        settled = true; clearTimeout(deadline); controller.signal.removeEventListener('abort', timeout);
        task.cancelState = cancelState; publishTasks();
        // Cancellation only stops a request. It does not undo a result already
        // committed by the Host, so reconcile real records even after not-active.
        if (!disposed) void reconcile();
        resolve({ requestId: task.requestId, cancelled: true, hostCancelled });
      };
      const timeout = () => finish('failed', null);
      controller.signal.addEventListener('abort', timeout, { once: true });
      let response;
      try { response = api.request('task.cancel', { requestId: task.requestId }, { signal: controller.signal }); }
      catch { finish('failed', null); return; }
      Promise.resolve(response).then(result => result?.cancelled === true ? finish('acknowledged', true)
        : result?.cancelled === false ? finish('not-active', false) : finish('failed', null), () => finish('failed', null));
    });
    return task.cancelPromise;
  }
  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe(notify) {
        listeners.add(notify);
        if (listeners.size === 1) {
          void refresh();
          timer = schedule(() => { if (!snapshot.pending) void refresh(); }, intervalMs);
        }
        return () => { listeners.delete(notify); if (!listeners.size && timer !== undefined) { unschedule(timer); timer = undefined; } };
      },
    },
    refresh,
    action: (action, input) => action === 'task.cancel'
      ? Promise.reject(Object.assign(new Error('Use this client’s current task cancellation'), { code: 'CLIENT_TASK_INTERNAL' }))
      : separateReads.has(action) ? tracked(signal => api.request(action, input, { signal }))
        : direct(action, (signal, requestId) => api.request(action, input, { signal, requestId })),
    upload: (file, metadata) => direct('material.upload', (signal, requestId) => api.upload(file, metadata, { signal, requestId })),
    cancelCurrent(expectedRequestId) {
      const task = tasks.get(snapshot.operation?.requestId);
      if (expectedRequestId !== undefined && expectedRequestId !== task?.requestId) return Promise.resolve({ cancelled: false });
      return !disposed && task && snapshot.operation.canCancel ? cancelTask(task) : Promise.resolve({ cancelled: false });
    },
    perform,
    dispose() {
      disposed = true;
      if (timer !== undefined) unschedule(timer);
      for (const task of tasks.values()) if (task.status === 'running') void cancelTask(task);
      for (const controller of controllers) controller.abort();
      listeners.clear();
    },
  };
}
