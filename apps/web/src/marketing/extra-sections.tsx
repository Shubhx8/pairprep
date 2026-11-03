import { Link } from "react-router-dom";
import { motion, type Variants } from "framer-motion";
import type { ReactNode } from "react";
import { Users, Timer, FileCode2, Send, ClipboardCheck, ArrowRight } from "lucide-react";
import { Button } from "./button.js";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "../components/ui/accordion.js";
import { features } from "../config/features.js";
import { routes } from "../config/routes.js";

const reveal: Variants = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] } },
};

function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      className={className}
      variants={reveal}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-60px" }}
      transition={{ delay }}
    >
      {children}
    </motion.div>
  );
}

const questions = [
  ["Is PairPrep free?", "Yes. Creating rooms and practising is free."],
  [
    "Do I need an account?",
    "You create rooms by signing in with Google or GitHub. Your partner can join with just the link.",
  ],
  ["Which languages are supported?", "Python, C++ and JavaScript."],
  ["How many people can join a room?", "Up to six."],
  [
    "Is my code private?",
    "Anyone with your room link can join, so share it only with the people you want. Code runs in isolated sandboxes with no network access.",
  ],
  [
    "What if my connection drops?",
    "Keep typing. Your changes merge automatically when you reconnect.",
  ],
  [
    "Does it work on my phone?",
    "PairPrep works best on a laptop. Rooms can be viewed on a phone.",
  ],
  ["Can I delete my data?", "Yes, you can delete rooms and your account."],
];

export function FAQ() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-5 py-24">
      <Reveal>
        <h2 className="mb-10 text-center text-3xl font-medium tracking-tight md:text-4xl">
          Frequently asked{" "}
          <span className="font-serif italic font-normal">questions.</span>
        </h2>
      </Reveal>
      <Reveal delay={0.1}>
        <div className="rounded-3xl border bg-card p-3 shadow-soft md:p-6">
          <Accordion type="single" collapsible>
            {questions.map(([question, answer], i) => (
              <motion.div
                key={question}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-40px" }}
                transition={{ duration: 0.6, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
              >
                <AccordionItem
                  value={`faq-${i}`}
                  className={i === questions.length - 1 ? "border-b-0" : ""}
                >
                  <AccordionTrigger className="min-h-11 px-3 text-base">
                    {question}
                  </AccordionTrigger>
                  <AccordionContent className="px-3 text-base leading-relaxed text-muted-foreground">
                    {answer}
                  </AccordionContent>
                </AccordionItem>
              </motion.div>
            ))}
          </Accordion>
        </div>
      </Reveal>
    </section>
  );
}

const interviewSteps = [
  { text: "Choose a problem", icon: FileCode2 },
  { text: "Invite your candidate", icon: Users },
  { text: "Start the interview", icon: Timer },
  { text: "Run and submit", icon: Send },
  { text: "Review together", icon: ClipboardCheck },
];

export function InterviewTeaser() {
  return (
    <section className="mx-auto max-w-[88rem] px-5 py-24 md:px-10">
      <Reveal className="text-center">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Interview mode
        </p>
        <h2 className="mt-4 text-3xl font-medium leading-tight tracking-tight md:text-4xl">
          Experience a technical interview,
          <br />
          <span className="font-serif italic font-normal">step by step.</span>
        </h2>
      </Reveal>
      <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {interviewSteps.map(({ text, icon: Icon }, i) => (
          <Reveal key={text} delay={i * 0.08} className="h-full">
            <li className="flex h-full flex-col rounded-3xl border bg-card p-5 shadow-soft transition hover:-translate-y-1">
              <div className="flex items-center justify-between">
                <span className="grid h-9 w-9 place-items-center rounded-full border bg-muted font-mono text-xs">
                  0{i + 1}
                </span>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </div>
              <span className="mt-8 text-base font-medium">{text}</span>
            </li>
          </Reveal>
        ))}
      </ol>
      <Reveal delay={0.2} className="mt-8 flex flex-col items-center gap-6">
        <div className="flex flex-wrap justify-center gap-3 text-sm">
          {features.sessionReplay && (
            <span className="rounded-full border bg-card px-3 py-1.5 shadow-soft">
              Session replay
            </span>
          )}
          {features.scorecard && (
            <span className="rounded-full border bg-card px-3 py-1.5 shadow-soft">
              Interview scorecard
            </span>
          )}
        </div>
        <Button
          asChild
          className="h-auto rounded-xl px-5 py-3 shadow-button transition hover:-translate-y-0.5"
        >
          <Link to={routes.interview}>
            See how mock interviews work <ArrowRight />
          </Link>
        </Button>
      </Reveal>
    </section>
  );
}
