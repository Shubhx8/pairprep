export const features = { interviewMode: true, sessionReplay: true, scorecard: true };
export type FeatureFlags = typeof features;
export function enabledInterviewItems(flags: FeatureFlags) {
  return flags.interviewMode
    ? [
        "interview",
        ...(flags.sessionReplay ? ["replay"] : []),
        ...(flags.scorecard ? ["scorecard"] : []),
      ]
    : [];
}
