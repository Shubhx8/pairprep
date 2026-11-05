export const features = {
  interviewMode: false,
  sessionReplay: false,
  scorecard: false,
  showRoadmap: false,
};
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
