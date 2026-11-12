/** Persist the user's reviewed text before submitting the same bytes to native chat. */
export async function submitReviewedVoiceAnswer({ api, submit }, input, signal) {
  signal?.throwIfAborted();
  if (input.speechDraftId) {
    const review = await api.request('interview.voiceReview', { interviewId: input.interviewId, questionId: input.questionId,
      speechDraftId: input.speechDraftId, editedTranscript: input.editedTranscript, finalText: input.text }, { signal });
    if (!review?.reviewed || review.interviewId !== input.interviewId || review.questionId !== input.questionId || review.speechDraftId !== input.speechDraftId) {
      throw Object.assign(new Error('The reviewed transcript was not saved.'), { code: 'VOICE_REVIEW_NOT_SAVED' });
    }
  }
  signal?.throwIfAborted();
  return submit(input.text, signal);
}
