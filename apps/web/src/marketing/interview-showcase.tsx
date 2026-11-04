import { useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import {
  Plus,
  Minus,
  Play,
  FileCode2,
  Folder,
  ChevronRight,
  ClipboardCheck,
  Timer,
  EyeOff,
  ArrowRight,
} from "lucide-react";

const items = [
  {
    title: "Collaborative editor",
    body: "Code, talk and think together in real time — see exactly how a candidate approaches a problem.",
  },
  {
    title: "Hidden test cases",
    body: "Interviewers see private tests and evaluation details. Candidates only see what they need.",
  },
  {
    title: "Built-in interviewer tools",
    body: "A synchronized timer, private notes and a structured 1–5 scorecard for every session.",
  },
  {
    title: "Session replay",
    body: "Step through how the code evolved, from the first idea to the final submission.",
  },
];

function Flag({ name, tone }: { name: string; tone: "you" | "partner" }) {
  return (
    <span className={`interview-flag ${tone === "you" ? "is-you" : "is-partner"}`}>
      {name}
    </span>
  );
}

function Visual({ index }: { index: number }) {
  if (index === 0)
    return (
      <div className="relative h-full w-full">
        <div className="interview-window absolute right-[6%] top-[8%] w-[62%] p-4">
          <div className="flex items-center gap-3">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-success">
              <Play className="h-3 w-3 fill-current" />
            </span>
            <span className="h-1.5 flex-1 rounded-full bg-panel-inner" />
          </div>
          <div className="mt-4 space-y-2 whitespace-pre font-mono text-[10px] text-panel-muted">
            <p>1 def two_sum(nums, target):</p>
            <p className="relative">
              2 seen = {"{}"} <Flag name="Partner" tone="partner" />
            </p>
            <p>3 for i, num in enumerate(nums):</p>
            <p className="relative">
              4 <Flag name="You" tone="you" />
            </p>
            <p>5</p>
          </div>
        </div>
        <div className="interview-paper absolute bottom-[10%] left-[8%] w-[46%] p-4">
          <p className="text-[11px] font-medium">Step 1</p>
          <p className="text-[10px] opacity-70">Store each number you've seen</p>
          <div className="mt-4 flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-md border border-current/30 font-mono text-[10px]">
              {"{ }"}
            </span>
            <ArrowRight className="h-4 w-4 opacity-60" />
            <span className="grid h-10 flex-1 place-items-center rounded-md border border-current/30 font-mono text-[10px]">
              O(n)
            </span>
          </div>
        </div>
      </div>
    );
  if (index === 1)
    return (
      <div className="relative h-full w-full">
        <div className="interview-window absolute left-[8%] top-[10%] w-[58%] p-4 font-mono text-[11px]">
          <p className="flex items-center gap-2 text-panel-muted">
            <EyeOff className="h-3.5 w-3.5" />
            INTERVIEWER ONLY
          </p>
          {["[2,7,11,15], 9", "[3,2,4], 6", "[3,3], 6", "[], 0"].map((t, i) => (
            <p key={t} className="mt-3 flex items-center justify-between">
              <span>
                test_{i + 1}({t})
              </span>
              <span className={i < 3 ? "text-success" : "text-dot-yellow"}>
                {i < 3 ? "PASS" : "EDGE"}
              </span>
            </p>
          ))}
        </div>
        <div className="interview-paper absolute bottom-[12%] right-[8%] w-[40%] p-4">
          <p className="text-[11px] font-medium">Candidate view</p>
          <p className="mt-2 text-[10px] opacity-70">3 of 4 tests passed</p>
          <div className="mt-3 h-1.5 rounded-full bg-current/15">
            <div className="h-full w-3/4 rounded-full bg-success" />
          </div>
        </div>
      </div>
    );
  if (index === 2)
    return (
      <div className="relative h-full w-full">
        <div className="interview-window absolute left-[8%] top-[12%] w-[52%] p-4">
          <p className="flex items-center justify-between text-[11px]">
            <span className="flex items-center gap-2">
              <Timer className="h-3.5 w-3.5" />
              Interview
            </span>
            <span className="font-mono text-success">24:12</span>
          </p>
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="mt-3 flex items-center gap-3">
              <span className="font-mono text-[10px] text-panel-muted">{n}</span>
              <span className="h-2 flex-1 rounded-full bg-panel-inner" />
            </div>
          ))}
          <div className="mt-4 flex items-center gap-2 text-[10px]">
            <span className="h-2.5 w-2.5 rounded-full bg-dot-yellow" />
            Interviewer
            <span className="ml-auto h-2.5 w-2.5 rounded-full bg-dot-red" />
            Candidate
          </div>
        </div>
        <div className="interview-paper absolute bottom-[8%] right-[7%] w-[44%] p-4">
          <p className="flex items-center gap-2 text-[11px] font-medium">
            <ClipboardCheck className="h-3.5 w-3.5" />
            Scorecard
          </p>
          {[
            ["Problem solving", 4],
            ["Communication", 5],
            ["Edge cases", 3],
          ].map(([l, v]) => (
            <div key={l} className="mt-2.5">
              <p className="text-[10px] opacity-70">{l}</p>
              <div className="mt-1 flex gap-1">
                {Array.from({ length: 5 }, (_, i) => (
                  <span
                    key={i}
                    className={`h-1.5 flex-1 rounded-sm ${i < (v as number) ? "bg-success" : "bg-current/15"}`}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  return (
    <div className="relative h-full w-full">
      <div className="interview-window absolute right-[8%] top-[10%] w-[60%]">
        <div className="flex items-center gap-2 border-b border-panel-muted/20 px-4 py-3 text-[11px]">
          <Folder className="h-3.5 w-3.5" />
          Replay · two-sum.py
        </div>
        <div className="space-y-1.5 p-4 font-mono text-[10px] text-panel-muted">
          <p className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3" />
            00:00 Join
          </p>
          <p className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3" />
            04:12 Chat
          </p>
          <p className="flex items-center gap-1 text-panel-foreground">
            <FileCode2 className="h-3 w-3" />
            09:38 Run
          </p>
          <p className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3" />
            12:06 Submit
          </p>
        </div>
      </div>
      <div className="interview-paper absolute bottom-[10%] left-[8%] w-[56%] p-4">
        <p className="flex items-center justify-between text-[10px]">
          <span>Candidate</span>
          <span className="font-mono opacity-70">09:38 / 12:06</span>
        </p>
        <div className="relative mt-3 h-1 rounded-full bg-current/15">
          <m.div
            className="absolute inset-y-0 left-0 rounded-full bg-success"
            initial={{ width: "10%" }}
            animate={{ width: "78%" }}
            transition={{ duration: 2.4, ease: "easeInOut" }}
          />
        </div>
        <div className="mt-3 flex gap-2">
          <Play className="h-3.5 w-3.5" />
          <span className="text-[10px] opacity-70">1x · 2x · 4x</span>
        </div>
      </div>
    </div>
  );
}

export function InterviewShowcase() {
  const [open, setOpen] = useState(0);
  return (
    <div className="interview-shell relative overflow-hidden rounded-3xl border border-foreground/10 p-5 shadow-soft md:p-8">
      <div className="grid gap-8 lg:grid-cols-[1fr_1.3fr] lg:items-center">
        <div className="space-y-3">
          {items.map((item, i) => {
            const on = open === i;
            return (
              <div
                key={item.title}
                className={`cursor-pointer rounded-2xl border p-4 transition-all duration-300 ${on ? "border-foreground/20 bg-card shadow-soft" : "border-transparent bg-transparent hover:bg-card/40"}`}
                onClick={() => setOpen(i)}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-medium">{item.title}</h3>
                  <span className="grid h-6 w-6 place-items-center rounded-full border bg-secondary text-xs">
                    {on ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                  </span>
                </div>
                <AnimatePresence>
                  {on && (
                    <m.p
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mt-2 text-sm leading-relaxed text-muted-foreground"
                    >
                      {item.body}
                    </m.p>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
        <div className="interview-stage relative h-80 overflow-hidden rounded-2xl border border-foreground/15 bg-card/60 md:h-96">
          <div className="interview-grid-lines absolute inset-0 opacity-40" />
          <Visual index={open} />
        </div>
      </div>
    </div>
  );
}
