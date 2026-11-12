const groups = [
  ['materials', ['material.add', 'material.update', 'material.get', 'material.fetch'], 'Create, revise or read selected personal and job materials. Confirmation is a user-only action in the workbench.'],
  ['goals', ['goal.create', 'goal.update', 'goal.linkMaterial', 'conversation.link'], 'Manage target jobs, confirmed material links and DSH conversation associations.'],
  ['assess', ['assessment.run'], 'Assess confirmed resume evidence or its fit to a confirmed target job. Input: kind resume|fit, versionId, optional goalId.'],
  ['rewrite', ['rewrite.run'], 'Generate a fact-preserving resume revision. The user accepts selected changes in the workbench.'],
  ['report', ['report.get'], 'Read a saved interview report by reportId or interviewId.'],
];

function denied(code, message) { throw Object.assign(new Error(message), { code }); }
function interviewForAgent(value) {
  if (!value?.questions) return value;
  return { ...value, questions: value.questions.map(({ speechDrafts, selectedSpeechReview, ...question }) => question) };
}
function materialSummary(value) {
  return { id: value.id, title: value.title, kind: value.kind, latestVersionId: value.latestVersionId,
    versions: (value.versions ?? []).map(({ id, revision, confirmed, confirmedAt, createdAt }) => ({ id, revision, confirmed, confirmedAt, createdAt })) };
}

// These are visible user requests, not synthetic Session events. Keep the two
// languages in sync with the workbench dictionaries (covered by contract tests).
export function parseInterviewRequest(text) {
  const start = /^请开始(中文|英文)模拟面试，共 ([1-9]|10) 个主要问题。$/.exec(text)
    || /^Please start a mock interview in (Chinese|English) with ([1-9]|10) main questions\.$/.exec(text);
  if (start) return { action: 'interview.start', language: ['英文', 'English'].includes(start[1]) ? 'en' : 'zh', questionCount: Number(start[2]) };
  const controls = new Map([
    ['请暂停这场模拟面试。', 'interview.pause'], ['Please pause this mock interview.', 'interview.pause'],
    ['请继续这场模拟面试。', 'interview.resume'], ['Please resume this mock interview.', 'interview.resume'],
    ['请结束这场模拟面试并生成报告。', 'interview.finish'], ['Please finish this mock interview and create the report.', 'interview.finish'],
  ]);
  if (controls.has(text)) return { action: controls.get(text) };
  const answer = /^(?:提交第 ([1-9][0-9]?) 题回答|Submit my answer to question ([1-9][0-9]?))\n\n([\s\S]+)$/.exec(text);
  if (answer) {
    const questionNumber = Number(answer[1] ?? answer[2]);
    if (questionNumber <= 20 && answer[3].trim()) return { action: 'interview.answer', questionNumber, text: answer[3] };
  }
  denied('INTERVIEW_USER_REQUEST_REQUIRED', 'Use the interview controls to start, submit an answer, pause, resume or finish. An answer must name its question, for example “提交第 1 题回答” or “Submit my answer to question 1”, followed by a blank line and your exact answer.');
}

function observeInterviewTurns(ctx) {
  const turns = new WeakMap();
  // Event delivery is post-commit. Never scan deprecated synchronous history
  // readers or treat injected/plugin/runtime user-role context as human input.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') turns.set(session, { messages: [], requests: new Map() });
    else if (event.type === 'turn/end') turns.delete(session);
    else if (event.type === 'user/message' && event.data.source?.kind === 'user') turns.get(session)?.messages.push(event.data);
  });
  return exec => {
    const session = exec.agent?.session;
    if (!session?.id) denied('NATIVE_SESSION_REQUIRED', 'Interview tools require the current DSH Agent session.');
    const turn = turns.get(session);
    if (!turn || turn.messages.length !== 1) denied('INTERVIEW_USER_REQUEST_REQUIRED', 'Submit one interview request in a new turn. No unique current human message is available.');
    const message = turn.messages[0];
    if (message.content?.length !== 1 || message.content[0].type !== 'text') denied('INTERVIEW_TEXT_REQUIRED', 'Confirm the answer as one text message before submitting it.');
    return { sessionId: session.id, turn, request: parseInterviewRequest(message.content[0].text) };
  };
}

export function registerCareerTools(ctx, dispatch) {
  const currentRequest = observeInterviewTurns(ctx);
  const register = (name, description, parameters, execute, readOnly = false) => ctx.tools.register({
    name, description, parameters, timeoutMs: 240000, isConcurrencySafe: () => readOnly,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute,
  });
  register('zhijing_context', 'Read the immutable resume and job versions attached to this DSH conversation. Use before giving advice about the current target job.',
    { type: 'object', properties: {}, additionalProperties: false }, async (_args, exec) => {
      const sessionId = exec.agent?.session?.id;
      if (!sessionId) return { linked: false, message: 'Open a 职镜AI conversation or select material versions explicitly.' };
      try {
        const context = await dispatch('conversation.context', { sessionId }, { signal: exec.signal, sessionId });
        const state = await dispatch('state', {}, { signal: exec.signal, sessionId });
        return { linked: true, ...context, interview: interviewForAgent(state.interviews.find(row => row.sessionId === sessionId) ?? null) };
      }
      catch (error) { if (error.code === 'CONVERSATION_NOT_FOUND') return { linked: false, message: 'This DSH conversation has no selected 职镜AI materials.' }; throw error; }
    }, true);
  register('zhijing_interview', 'Execute the current human interview request in THIS DSH session. First read zhijing_context. Start/pause/resume/finish use the workbench controls. Answers must be a human message headed “提交第 N 题回答” or “Submit my answer to question N”, blank line, then the exact answer. N is the 1-based question position including followups; a queued answer to an older question is refused. Never turn ordinary discussion, control text, or a generated example into an answer. Omit input.text to use the original answer; if supplied it must match byte for byte. Session, goal, resume, interview and question identities are fixed by this session and human message, never chosen by the model. Return the actual next question or report without inventing answers.',
    { type: 'object', properties: { action: { type: 'string', enum: ['interview.start', 'interview.answer', 'interview.pause', 'interview.resume', 'interview.finish'] }, input: { type: 'object', additionalProperties: true } }, required: ['action'], additionalProperties: false },
    async (args, exec) => {
      const { sessionId, turn, request } = currentRequest(exec);
      const input = args?.input ?? {};
      if (!input || typeof input !== 'object' || Array.isArray(input) || args.action !== request.action) denied('INTERVIEW_REQUEST_MISMATCH', 'The tool action must match the current human request.');
      if (input.sessionId !== undefined && input.sessionId !== sessionId) denied('INTERVIEW_SESSION_MISMATCH', 'Another session cannot be selected.');
      if (request.action === 'interview.answer' && input.text !== undefined && input.text !== request.text) denied('INTERVIEW_ANSWER_MISMATCH', 'The answer must exactly match the confirmed human text.');
      const options = { signal: exec.signal, sessionId, modelSelection: exec.agent?.model?.current() };
      const context = await dispatch('conversation.context', { sessionId }, options);
      if (context.kind !== 'interview' || !context.goalId) denied('INTERVIEW_SESSION_REQUIRED', 'Start an interview from the target job workbench to bind confirmed materials.');
      const resume = context.materials.find(row => row.kind === 'resume');
      if (!resume || !context.materials.some(row => row.kind === 'job')) denied('JOB_MATERIAL_REQUIRED', 'This interview requires confirmed resume and job versions.');
      for (const [key, expected] of [['goalId', context.goalId], ['versionId', resume.id]]) {
        if (input[key] !== undefined && input[key] !== expected) denied('INTERVIEW_CONTEXT_MISMATCH', 'Use the material versions already attached to this session.');
      }
      const state = await dispatch('state', {}, options);
      const interview = state.interviews.find(row => row.sessionId === sessionId);
      if (input.interviewId !== undefined && input.interviewId !== interview?.id) denied('INTERVIEW_SESSION_MISMATCH', 'Another interview cannot be selected.');
      const answeredQuestion = request.action === 'interview.answer' ? interview?.questions?.[request.questionNumber - 1] : null;
      if (request.action === 'interview.answer') {
        if (!answeredQuestion) denied('QUESTION_CHANGED', 'The human request names a question that is not available in this interview.');
        if ((input.questionNumber !== undefined && input.questionNumber !== request.questionNumber)
          || (input.questionId !== undefined && input.questionId !== answeredQuestion.id)) denied('INTERVIEW_QUESTION_MISMATCH', 'The question must match the current human request.');
      }
      // A model may retry the same call in a later step. One human request may
      // mutate the interview once; retries share that exact result or failure.
      if (turn.requests.has(request.action)) return turn.requests.get(request.action);
      if (request.action === 'interview.start' && interview) return interviewForAgent(interview);
      if (request.action !== 'interview.start' && !interview) denied('INTERVIEW_NOT_FOUND', 'This session has no interview yet.');
      if (answeredQuestion && (answeredQuestion.id !== interview.currentQuestionId || answeredQuestion.answer)) denied('QUESTION_CHANGED', 'This answer belongs to a question that has already changed. Submit the current question from the workbench.');
      const data = request.action === 'interview.start'
        ? { sessionId, goalId: context.goalId, versionId: resume.id, language: request.language, questionCount: request.questionCount }
        : { interviewId: interview.id, ...(request.action === 'interview.answer' ? { text: request.text, questionId: answeredQuestion.id } : {}) };
      const pending = dispatch(request.action, data, options).then(interviewForAgent);
      turn.requests.set(request.action, pending);
      return pending;
    });
  register('zhijing_state', 'List 职镜AI materials, versions, target jobs and interview records. Never invent IDs.',
    { type: 'object', properties: {}, additionalProperties: false }, async (_args, exec) => {
      const state = await dispatch('state', {}, { signal: exec.signal });
      return { materials: state.materials.map(({ id, title, kind, latestVersionId, versions }) => ({ id, title, kind, latestVersionId,
        versions: versions.map(({ id, revision, confirmed }) => ({ id, revision, confirmed })) })),
        goals: state.goals.map(({ id, title, company, status, materialLinks, conversations }) => ({ id, title, company, status, materialLinks, conversations })),
        interviews: state.interviews.map(({ id, goalId, sessionId, status }) => ({ id, goalId, sessionId, status })),
        reports: state.reports.map(({ id, interviewId }) => ({ id, interviewId })) };
    }, true);
  for (const [name, actions, description] of groups) register(`zhijing_${name}`, description,
    { type: 'object', properties: { action: { type: 'string', enum: actions }, input: { type: 'object', additionalProperties: true } }, required: ['action', 'input'], additionalProperties: false },
    async (args, exec) => {
      if (!args || !actions.includes(args.action) || !args.input || typeof args.input !== 'object' || Array.isArray(args.input)) throw new Error('Invalid 职镜AI tool arguments');
      const sessionId = exec.agent?.session?.id;
      if (args.action === 'conversation.link') {
        if (!sessionId || (args.input.sessionId !== undefined && args.input.sessionId !== sessionId)) denied('NATIVE_SESSION_REQUIRED', 'Link only the actual current DSH session.');
        return dispatch(args.action, { ...args.input, sessionId }, { signal: exec.signal, sessionId });
      }
      if (args.action === 'material.get' && (typeof args.input.versionId !== 'string' || !args.input.versionId.trim())) denied('MATERIAL_VERSION_REQUIRED', 'Select one confirmed material version before reading its text.');
      const value = await dispatch(args.action, args.input, { signal: exec.signal, sessionId, modelSelection: exec.agent?.model?.current() });
      if (args.action === 'material.get' && value?.confirmed !== true) denied('MATERIAL_NOT_CONFIRMED', 'Ask the user to review and confirm this material in the workbench before reading its text.');
      return ['material.add', 'material.update', 'material.fetch'].includes(args.action) ? materialSummary(value) : value;
    }, name === 'report');
}
