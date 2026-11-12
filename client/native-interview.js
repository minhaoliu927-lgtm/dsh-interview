export function interviewPrompt(action, input, t) {
  if (action === 'interview.start') return t('interviewStartPrompt', { language: t(input.language === 'en' ? 'enLanguage' : 'zhLanguage'), number: input.questionCount });
  if (action === 'interview.answer') {
    if (typeof input.text !== 'string' || !input.text.trim()) throw new Error(t('answerPlaceholder'));
    if (!Number.isInteger(input.questionNumber) || input.questionNumber < 1 || input.questionNumber > 20) throw Object.assign(new Error('Select the current interview question before submitting an answer.'), { code: 'QUESTION_CHANGED' });
    return `${t('interviewAnswerPrompt', { number: input.questionNumber })}\n\n${input.text}`;
  }
  const key = { 'interview.pause': 'interviewPausePrompt', 'interview.resume': 'interviewResumePrompt', 'interview.finish': 'interviewFinishPrompt' }[action];
  if (!key) throw new Error('Invalid interview action');
  return t(key);
}

/** Send through DSH's actual admission/echo API; never fall back to HTTP. */
export async function submitNativePrompt(sessions, sessionId, text, signal) {
  if (!sessionId || typeof sessions?.using !== 'function') throw Object.assign(new Error('DSH native conversation submission is unavailable.'), { code: 'NATIVE_PROMPT_UNAVAILABLE' });
  return sessions.using(sessionId, { source: 'zhijingChat', signal }, async reference => {
    const { session } = await reference.ready;
    signal?.throwIfAborted();
    const submission = session.beginSubmission({ mode: 'queue', text, attachments: [] });
    let reachedPrompt = false;
    try {
      signal?.throwIfAborted();
      reachedPrompt = true;
      const result = await session.prompt([{ type: 'text', text }], 'queue', signal, submission.requestId);
      if (!result?.ok || result.value?.accepted !== true) throw Object.assign(new Error(result?.error?.message || 'DSH did not accept the interview message.'), { code: result?.error?.code || 'NATIVE_PROMPT_REJECTED' });
      return { accepted: true, sessionId };
    } finally { if (!reachedPrompt) submission.abandon(); }
  });
}
