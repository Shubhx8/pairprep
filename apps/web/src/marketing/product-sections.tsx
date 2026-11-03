import { useEffect, useState, type ReactNode } from "react";
import { motion, type Variants } from "framer-motion";
import {
  Check,
  Code2,
  Users,
  Timer,
  LockKeyhole,
  Play,
  Pause,
  FileCode2,
  MessageCircle,
  Send,
  ClipboardCheck,
  CircleDot,
} from "lucide-react";
import { Button } from "./button.js";
import { interviewSteps, productFeatures, replayEvents } from "../lib/product-roadmap.js";
import { features } from "../config/features.js";

const mountains = "/images/mountains.webp";

const reveal: Variants = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] } },
};

function Entrance({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      className={className}
      variants={reveal}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-40px" }}
    >
      {children}
    </motion.div>
  );
}

export function RoadmapBadge() {
  if (!features.showRoadmap) return null;
  return (
    <span className="roadmap-badge inline-flex items-center gap-1.5 rounded-full border border-roadmap/25 bg-roadmap/10 px-2.5 py-1 font-mono text-[10px] text-roadmap">
      <CircleDot className="h-3 w-3" />
      Phase 2 Roadmap
    </span>
  );
}

const snippets: Record<string, string> = {
  Python:
    "def two_sum(nums, target):\n    seen = {}\n    for i, num in enumerate(nums):\n        complement = target - num\n        if complement in seen:\n            return [seen[complement], i]\n        seen[num] = i",
  "C++":
    "vector<int> twoSum(vector<int>& nums, int target) {\n    unordered_map<int, int> seen;\n    for (int i = 0; i < nums.size(); ++i) {\n        int complement = target - nums[i];\n        if (seen.count(complement))\n            return {seen[complement], i};\n        seen[nums[i]] = i;\n    }\n    return {};\n}",
  JavaScript:
    "function twoSum(nums, target) {\n  const seen = new Map();\n  for (const [i, num] of nums.entries()) {\n    const complement = target - num;\n    if (seen.has(complement))\n      return [seen.get(complement), i];\n    seen.set(num, i);\n  }\n}",
};

function CodeLines({ code }: { code: string }) {
  return (
    <div className="overflow-x-auto py-3 font-mono text-[11px] leading-6 sm:text-xs">
      {code.split("\n").map((line, i) => (
        <div key={i} className="flex min-w-max gap-4 pr-4">
          <span className="w-6 shrink-0 select-none text-right text-panel-muted/60">
            {i + 1}
          </span>
          <span
            className={
              line.includes("return")
                ? "whitespace-pre text-success"
                : "whitespace-pre text-panel-foreground"
            }
          >
            {line || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ProductWorkspace({
  interview = false,
  compact = false,
}: {
  interview?: boolean;
  compact?: boolean;
}) {
  const [language, setLanguage] = useState<string>("Python");
  return (
    <div className="w-full overflow-hidden rounded-lg border border-panel-muted/25 text-panel-foreground glass-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-panel-muted/20 px-4 py-3">
        <span className="flex items-center gap-2 text-xs">
          <Code2 className="h-4 w-4" />
          PairPrep / two-sum
        </span>
        {interview ? (
          <RoadmapBadge />
        ) : (
          <span className="font-mono text-[10px] text-panel-muted">
            Practice · product preview
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-panel-muted/20 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <Users className="h-3.5 w-3.5 text-success" />
          <span>{interview ? "Interviewer" : "You"}</span>
          <span className="text-panel-muted">+</span>
          <span>{interview ? "Candidate" : "Your partner"}</span>
          <span className="ml-2 flex items-center gap-1 text-success">
            <span className="h-1 w-1 rounded-full bg-success" />
            {interview ? "Ready" : "Connected"}
          </span>
        </div>
        {interview ? (
          <span className="flex items-center gap-1 font-mono text-xs">
            <Timer className="h-3.5 w-3.5" />
            24:08 / 30:00
          </span>
        ) : (
          <label className="flex items-center gap-2 font-mono text-[10px] text-panel-muted">
            Language
            <select
              aria-label="Preview programming language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="rounded border border-panel-muted/30 bg-panel px-2 py-1 text-panel-foreground"
            >
              {productFeatures.practice.languages.map((l) => (
                <option key={l} value={l} className="bg-primary text-primary-foreground">
                  {l}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className={`grid ${compact ? "" : "md:grid-cols-[minmax(0,1fr)_180px]"}`}>
        <div className="min-w-0">
          <div className="border-b border-panel-muted/20 px-4 py-3">
            <p className="text-xs font-medium">Two Sum</p>
            <p className="mt-1 text-[11px] leading-relaxed text-panel-muted">
              Find two numbers whose sum equals the target.
            </p>
          </div>
          <CodeLines code={snippets[language] ?? snippets["Python"] ?? ""} />
          <div className="border-t border-panel-muted/20 px-4 py-3 font-mono text-[10px]">
            <span className="text-panel-muted">OUTPUT </span>
            <span className="ml-3 text-success">[0, 1]</span>
            <span className="ml-3 text-panel-muted">target = 9</span>
          </div>
        </div>
        {!compact && (
          <aside className="hidden border-l border-panel-muted/20 p-4 md:block">
            <p className="flex items-center gap-2 text-xs">
              <MessageCircle className="h-3.5 w-3.5" />
              {interview ? "Interview" : "Discussion"}
            </p>
            <p className="mt-6 text-[10px] text-panel-muted">
              {interview ? "Interviewer" : "Your partner"}
            </p>
            <p className="mt-2 text-xs leading-relaxed">
              What if we keep track of the numbers we’ve already seen?
            </p>
            <p className="mt-5 text-[10px] text-panel-muted">
              {interview ? "Candidate" : "You"}
            </p>
            <p className="mt-2 text-xs leading-relaxed">
              A map lets us check each complement.
            </p>
            {interview && (
              <p className="mt-6 flex items-center gap-2 text-[10px] text-roadmap">
                <LockKeyhole className="h-3.5 w-3.5" />
                Hidden tests · interviewer only
              </p>
            )}
          </aside>
        )}
      </div>
      {interview && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-panel-muted/20 px-4 py-3">
          <span className="font-mono text-[10px] text-panel-muted">
            Evaluation preview · problem / code / edge cases
          </span>
          <span className="flex items-center gap-1 rounded border border-panel-muted/30 px-3 py-1.5 text-[10px]">
            <Send className="h-3 w-3" />
            {features.showRoadmap ? "Submit · upcoming" : "Submit"}
          </span>
        </div>
      )}
    </div>
  );
}

export function TwoModes() {
  return (
    <section id="experience" className="mx-auto max-w-[88rem] px-5 py-24 md:px-10">
      <Entrance className="text-center">
        <p className="text-xs text-muted-foreground">THE PAIRPREP EXPERIENCE</p>
        <h2 className="mt-4 text-3xl font-medium leading-tight md:text-5xl">
          One workspace.
          <br />
          <span className="font-serif italic font-normal">Two ways to grow.</span>
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Whether you are learning with a partner or preparing for a technical interview,
          PairPrep brings the coding experience into one shared environment.
        </p>
      </Entrance>
      <div className="mt-12 grid gap-6 lg:grid-cols-2">
        <Entrance>
          <article className="mode-card relative flex h-full flex-col overflow-hidden rounded-lg border bg-card shadow-soft">
            <div className="px-6 pb-6 pt-7 sm:px-8">
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Users className="h-4 w-4" />
                PRACTICE MODE{" "}
                <span className="ml-auto font-mono text-[10px]">CORE EXPERIENCE</span>
              </span>
              <h3 className="mt-5 text-2xl font-medium">Learn by building together.</h3>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
                Create a room, invite a partner, write code together and explore different
                approaches to solving problems.
              </p>
            </div>
            <div className="relative mt-auto overflow-hidden px-4 pb-4 sm:px-6 sm:pb-6">
              <img
                src={mountains}
                alt=""
                loading="lazy"
                width={1280}
                height={720}
                className="absolute inset-0 h-full w-full object-cover"
              />
              <div className="relative">
                <ProductWorkspace compact />
              </div>
            </div>
          </article>
        </Entrance>
        <Entrance>
          <article className="mode-card flex h-full flex-col overflow-hidden rounded-lg border bg-card shadow-soft">
            <div className="px-6 pb-6 pt-7 sm:px-8">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Timer className="h-4 w-4" />
                  INTERVIEW MODE
                </span>
                <RoadmapBadge />
              </div>
              <h3 className="mt-5 text-2xl font-medium">
                Prepare by experiencing the real thing.
              </h3>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
                Take the interviewer or candidate role, work through a timed problem and
                evaluate the solution using structured interview workflows.
              </p>
            </div>
            <div className="preview-surface mt-auto px-4 pb-4 sm:px-6 sm:pb-6">
              <ProductWorkspace compact interview />
            </div>
          </article>
        </Entrance>
      </div>
    </section>
  );
}

const workflowIcons = [FileCode2, Users, Timer, Send, ClipboardCheck];
function WorkflowVisual({ index }: { index: number }) {
  if (index === 0)
    return (
      <>
        <p className="text-xs">
          Two Sum <span className="float-right text-success">Easy</span>
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <span className="border border-panel-muted/20 p-2 text-[10px]">Python</span>
          <span className="border border-panel-muted/20 p-2 text-[10px]">30 minutes</span>
        </div>
        <p className="mt-4 text-[10px] text-panel-muted">Arrays · Hash maps</p>
      </>
    );
  if (index === 1)
    return (
      <>
        <p className="text-[10px] text-panel-muted">ROOM / INTERVIEW PREVIEW</p>
        {["Interviewer", "Candidate"].map((t) => (
          <div
            key={t}
            className="mt-3 flex items-center justify-between border-b border-panel-muted/20 pb-2 text-xs"
          >
            <span className="flex items-center gap-2">
              <Users className="h-3 w-3" />
              {t}
            </span>
            <Check className="h-3 w-3 text-success" />
          </div>
        ))}
      </>
    );
  if (index === 2)
    return (
      <>
        <p className="flex items-center justify-between text-xs">
          <span>Two Sum</span>
          <span className="font-mono text-roadmap">24:08</span>
        </p>
        <CodeLines
          code={
            "seen = {}\nfor i, num in enumerate(nums):\n    complement = target - num"
          }
        />
      </>
    );
  if (index === 3)
    return (
      <>
        <p className="flex items-center gap-2 text-xs">
          <LockKeyhole className="h-3.5 w-3.5" />
          Hidden tests
        </p>
        <div className="mt-4 space-y-2">
          {["Expected output", "Edge cases", "Evaluation"].map((t) => (
            <p
              key={t}
              className="flex items-center justify-between text-[10px] text-panel-muted"
            >
              {t}
              <Check className="h-3 w-3 text-success" />
            </p>
          ))}
        </div>
      </>
    );
  return (
    <>
      <p className="text-xs">Session summary</p>
      <div className="mt-4 flex items-end gap-2">
        {[60, 80, 65, 75].map((_, i) => (
          <div key={i} className="flex h-16 flex-1 items-end rounded-sm bg-panel-inner">
            <div
              className={`w-full rounded-sm bg-success/60 ${["h-3/5", "h-4/5", "h-2/3", "h-3/4"][i]}`}
            />
          </div>
        ))}
      </div>
      <p className="mt-3 text-[10px] text-panel-muted">Sample scorecard · code replay</p>
    </>
  );
}

export function InterviewWorkflow() {
  return (
    <section id="interview" className="mx-auto max-w-[88rem] px-5 py-24 md:px-10">
      <Entrance className="flex flex-wrap items-end justify-between gap-5">
        <div className="max-w-2xl">
          <RoadmapBadge />
          {features.showRoadmap && (
            <p className="mt-5 text-xs text-muted-foreground">INTERVIEW MODE — PHASE 2</p>
          )}
          <h2 className="mt-4 text-3xl font-medium leading-tight md:text-4xl">
            Experience a technical interview,
            <br />
            <span className="font-serif italic font-normal">step by step.</span>
          </h2>
        </div>
        <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
          Move beyond solving problems alone. Experience the roles, structure and
          evaluation of a realistic coding interview.
        </p>
      </Entrance>
      <div className="interview-grid relative mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        {interviewSteps.map((step, i) => {
          const Icon = workflowIcons[i] ?? FileCode2;
          return (
            <Entrance
              key={step.title}
              className={`min-w-0 ${i < 3 ? "lg:col-span-2" : "lg:col-span-3"}`}
            >
              <article className="group flex h-full flex-col rounded-lg border bg-card p-5 shadow-soft transition-transform duration-300 hover:-translate-y-1">
                <div className="flex items-center justify-between">
                  <span className="grid h-9 w-9 place-items-center rounded-full border bg-secondary font-mono text-xs">
                    0{i + 1}
                  </span>
                  <Icon className="h-4 w-4 text-muted-foreground" />
                </div>
                <h3 className="mt-5 text-lg font-medium">{step.title}</h3>
                <p className="mt-2 min-h-16 text-sm leading-relaxed text-muted-foreground">
                  {step.body}
                </p>
                <div className="preview-surface mt-6 min-h-36 rounded-md p-4 text-panel-foreground">
                  <WorkflowVisual index={i} />
                </div>
                <div className="mt-auto pt-4">
                  <RoadmapBadge />
                </div>
              </article>
            </Entrance>
          );
        })}
      </div>
    </section>
  );
}

function ReplayPreview() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setIndex((current) => {
        if (current >= replayEvents.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 1800 / speed);
    return () => window.clearInterval(timer);
  }, [playing, speed]);
  const event = replayEvents[index] ?? replayEvents[0];
  if (!event) return null;
  return (
    <div className="preview-surface overflow-hidden rounded-md text-panel-foreground">
      <div className="flex items-center justify-between border-b border-panel-muted/20 px-4 py-3 text-[10px]">
        <span className="flex items-center gap-2">
          <FileCode2 className="h-3.5 w-3.5" />
          two-sum.py · read only
        </span>
        <span className="text-panel-muted">Sample replay</span>
      </div>
      <div className="min-h-60">
        <CodeLines code={event.code} />
      </div>
      <div className="border-t border-panel-muted/20 p-4">
        <div className="flex items-center justify-between text-[10px]">
          <span>
            {event.at}{" "}
            <span className="ml-2 text-panel-muted">
              {event.author} / {event.label}
            </span>
          </span>
          <span className="text-panel-muted">12:06</span>
        </div>
        <label className="sr-only" htmlFor="replay-position">
          Sample replay position
        </label>
        <input
          id="replay-position"
          type="range"
          min="0"
          max={replayEvents.length - 1}
          value={index}
          onChange={(e) => {
            setIndex(Number(e.target.value));
            setPlaying(false);
          }}
          className="replay-range mt-4 w-full"
        />
        <div className="mt-1 flex justify-between font-mono text-[9px] text-panel-muted">
          {replayEvents.map((e) => (
            <span key={e.label}>{e.label}</span>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2">
          <Button
            size="icon"
            variant="ghost"
            aria-label={playing ? "Pause sample replay" : "Play sample replay"}
            title={playing ? "Pause sample replay" : "Play sample replay"}
            onClick={() => {
              if (index === replayEvents.length - 1) setIndex(0);
              setPlaying(!playing);
            }}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
          <div className="flex gap-1">
            {[1, 2, 4].map((value) => (
              <Button
                key={value}
                size="sm"
                variant="ghost"
                aria-pressed={speed === value}
                onClick={() => setSpeed(value)}
                className={speed === value ? "bg-panel-inner" : "text-panel-muted"}
              >
                {value}x
              </Button>
            ))}
          </div>
          <span className="ml-auto text-[10px] text-panel-muted">
            Code & session events
          </span>
        </div>
      </div>
    </div>
  );
}

function ScorecardPreview() {
  const criteria = [
    { title: "Problem solving", value: 4 },
    { title: "Code quality", value: 4 },
    { title: "Communication", value: 5 },
    { title: "Edge-case handling", value: 3 },
  ];
  return (
    <div className="preview-surface rounded-md p-5 text-panel-foreground">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-xs">
          <ClipboardCheck className="h-4 w-4" />
          Two Sum / Scorecard
        </p>
        <span className="text-[10px] text-panel-muted">SAMPLE</span>
      </div>
      <div className="mt-7 space-y-5">
        {criteria.map((c) => (
          <div key={c.title}>
            <div className="flex items-center justify-between text-xs">
              <span>{c.title}</span>
              <span className="font-mono text-panel-muted">{c.value} / 5</span>
            </div>
            <div
              className="mt-2 flex gap-1.5"
              aria-label={`${c.title}: ${c.value} out of 5`}
            >
              {Array.from({ length: 5 }, (_, i) => (
                <span
                  key={i}
                  className={`h-1.5 flex-1 rounded-sm ${i < c.value ? "bg-success/75" : "bg-panel-inner"}`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-7 border-t border-panel-muted/20 pt-4">
        <p className="text-[10px] text-panel-muted">INTERVIEWER COMMENTS</p>
        <p className="mt-2 text-xs leading-relaxed">
          Clear explanation of the hash-map approach. Next time, discuss empty input and
          duplicate values before coding.
        </p>
        <p className="mt-4 text-[10px] text-success">
          Next focus: edge cases & complexity analysis
        </p>
      </div>
    </div>
  );
}

export function FeedbackShowcase() {
  return (
    <section id="feedback" className="mx-auto max-w-[88rem] px-5 py-24 md:px-10">
      <Entrance className="text-center">
        <p className="text-xs text-muted-foreground">AFTER THE INTERVIEW</p>
        <h2 className="mt-4 text-3xl font-medium leading-tight md:text-4xl">
          Every interview leaves
          <br />
          <span className="font-serif italic font-normal">something to learn.</span>
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Your preparation should not end when the timer does. Review how the solution
          evolved, understand your performance and identify what you can improve next
          time.
        </p>
      </Entrance>
      <div className="mt-12 grid gap-6 lg:grid-cols-2">
        <Entrance>
          <article className="h-full rounded-lg border bg-card p-5 shadow-soft sm:p-7">
            <RoadmapBadge />
            <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
              <Play className="h-3.5 w-3.5" />
              SESSION REPLAY
            </p>
            <h3 className="mt-3 text-2xl font-medium">
              See how the solution came together.
            </h3>
            <p className="mb-6 mt-3 text-sm leading-relaxed text-muted-foreground">
              Revisit code changes with timestamps and authors. Follow important moments
              from the session and understand how the final solution evolved.
            </p>
            <ReplayPreview />
          </article>
        </Entrance>
        <Entrance>
          <article className="h-full rounded-lg border bg-card p-5 shadow-soft sm:p-7">
            <RoadmapBadge />
            <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
              <ClipboardCheck className="h-3.5 w-3.5" />
              INTERVIEW SCORECARD
            </p>
            <h3 className="mt-3 text-2xl font-medium">
              Turn every interview into actionable feedback.
            </h3>
            <p className="mb-6 mt-3 text-sm leading-relaxed text-muted-foreground">
              Evaluate problem solving, code quality, communication and edge-case handling
              with structured ratings and comments.
            </p>
            <ScorecardPreview />
          </article>
        </Entrance>
      </div>
      {features.showRoadmap && (
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Interview Mode, Session Replay and Scorecard are planned for Phase 2. All
          interfaces shown are product previews.
        </p>
      )}
    </section>
  );
}
