export const productFeatures = {
  practice: { phase: 1, available: true, languages: ["Python", "C++", "JavaScript"] },
  interview: { phase: 2, available: false },
  replay: { phase: 2, available: false, recording: "document-updates-and-events" },
  scorecard: { phase: 2, available: false, ratingMin: 1, ratingMax: 5 },
} as const;

export const interviewSteps = [
  {
    title: "Choose a Problem",
    body: "Select a coding problem, programming language and interview duration.",
    detail: "Two Sum · Python · 30 minutes",
    icon: "problem",
  },
  {
    title: "Invite Your Candidate",
    body: "Share an interview link and let the candidate join with their assigned role.",
    detail: "Interviewer + candidate · Ready check",
    icon: "people",
  },
  {
    title: "Start the Interview",
    body: "Work against a synchronized timer while discussing and solving the problem.",
    detail: "Problem statement · Shared editor · Timer",
    icon: "timer",
  },
  {
    title: "Run and Submit",
    body: "Test the solution against hidden test cases, with detailed evaluation available to the interviewer.",
    detail: "Hidden tests · Submission · Evaluation",
    icon: "run",
  },
  {
    title: "Review Together",
    body: "Finish with structured feedback, an interview summary and a replay of how the code evolved.",
    detail: "Code replay · Scorecard · Next steps",
    icon: "review",
  },
] as const;

export const replayEvents = [
  {
    at: "00:00",
    label: "Join",
    author: "Candidate",
    code: "def two_sum(nums, target):\n    # Explore an approach together\n    pass",
  },
  {
    at: "04:12",
    label: "Chat",
    author: "Interviewer",
    code: "def two_sum(nums, target):\n    seen = {}\n    for i, num in enumerate(nums):\n        complement = target - num",
  },
  {
    at: "09:38",
    label: "Run",
    author: "Candidate",
    code: "def two_sum(nums, target):\n    seen = {}\n    for i, num in enumerate(nums):\n        complement = target - num\n        if complement in seen:\n            return [seen[complement], i]\n        seen[num] = i",
  },
  {
    at: "12:06",
    label: "Submit",
    author: "Candidate",
    code: "def two_sum(nums, target):\n    seen = {}\n    for i, num in enumerate(nums):\n        complement = target - num\n        if complement in seen:\n            return [seen[complement], i]\n        seen[num] = i\n    return []",
  },
] as const;
