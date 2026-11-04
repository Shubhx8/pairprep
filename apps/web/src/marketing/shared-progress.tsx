import { useEffect, useRef, useState, type ReactNode } from "react";
import { m, useScroll, useTransform, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  MessageCircle,
  GitBranch,
  Check,
  Play,
  Timer,
  Users,
  Bug,
  Lightbulb,
} from "lucide-react";
import { Button } from "./button.js";
import { features } from "../config/features.js";

const outcomes = [
  {
    title: "Explain your thinking.",
    body: "Build the habit of talking through your approach while you solve — exactly what interviewers look for.",
    label: "Communicate your approach",
    icon: MessageCircle,
    tone: "progress-sage",
  },
  {
    title: "See another perspective.",
    body: "Discover different ways to attack the same problem by working next to another developer.",
    label: "Learn from another view",
    icon: GitBranch,
    tone: "progress-blue",
  },
  {
    title: "Catch bugs together.",
    body: "Two sets of eyes spot edge cases, off-by-ones and missing checks before the tests do.",
    label: "Debug as a team",
    icon: Bug,
    tone: "progress-sand",
  },
  {
    title: "Practice under pressure.",
    body: "A shared timer and a real partner recreate the feel of a live interview — so the real one feels familiar.",
    label: "Build calm under time",
    icon: Timer,
    tone: "progress-rose",
  },
  {
    title: "Learn from every session.",
    body: "Replay how the code evolved and use structured feedback to know what to work on next.",
    label: "Turn feedback into progress",
    icon: Play,
    tone: "progress-lilac",
  },
];

function Node({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`progress-node grid place-items-center rounded-xl ${className}`}>
      {children}
    </span>
  );
}

function Illustration({ index }: { index: number }) {
  const draw = {
    initial: { pathLength: 0 },
    whileInView: { pathLength: 1 },
    viewport: { once: true },
    transition: { duration: 1.2, ease: "easeInOut" as const },
  };
  return (
    <div
      className="progress-illustration relative h-52 overflow-hidden rounded-xl border border-foreground/10"
      aria-hidden="true"
    >
      {index === 0 && (
        <div className="relative h-full p-5">
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox="0 0 320 200"
            fill="none"
          >
            <m.path {...draw} d="M70 100 H160 V60 H250" className="progress-line" />
            <m.path {...draw} d="M160 100 V140 H250" className="progress-line" />
          </svg>
          <Node className="absolute left-6 top-[68px] h-16 w-16">
            <Users className="h-6 w-6" />
          </Node>
          <m.div
            initial={{ opacity: 0, x: 12 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.6 }}
            className="progress-bubble absolute right-5 top-8 px-3 py-2 text-[11px]"
          >
            “Could a map help?”
          </m.div>
          <m.div
            initial={{ opacity: 0, x: 12 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.9 }}
            className="progress-bubble absolute bottom-8 right-5 flex items-center gap-1.5 px-3 py-2 text-[11px]"
          >
            <Check className="h-3 w-3" />
            Let’s try it.
          </m.div>
        </div>
      )}
      {index === 1 && (
        <div className="relative h-full p-5">
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox="0 0 320 200"
            fill="none"
          >
            <m.path
              {...draw}
              d="M160 40 C160 90 80 90 80 130"
              className="progress-line"
            />
            <m.path
              {...draw}
              d="M160 40 C160 90 240 90 240 130"
              className="progress-line"
            />
          </svg>
          <Node className="absolute left-1/2 top-4 h-12 w-12 -translate-x-1/2">
            <Lightbulb className="h-5 w-5" />
          </Node>
          <div className="progress-bubble absolute bottom-6 left-5 w-28 p-3 font-mono text-[10px]">
            <p className="opacity-60">A · loops</p>
            <p className="mt-1">O(n²)</p>
          </div>
          <div className="progress-bubble is-strong absolute bottom-6 right-5 w-28 p-3 font-mono text-[10px]">
            <p className="opacity-70">B · hash map</p>
            <p className="mt-1">O(n)</p>
          </div>
        </div>
      )}
      {index === 2 && (
        <div className="relative h-full p-5 font-mono text-[11px]">
          <div className="progress-bubble p-3 leading-6">
            <p>
              for i in range(len(nums)
              <span className="progress-highlight">+1</span>):
            </p>
            <p className="opacity-60"> check(nums[i])</p>
          </div>
          <m.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.6 }}
            className="progress-bubble is-strong absolute bottom-5 left-5 right-5 flex items-center gap-2 p-3"
          >
            <Bug className="h-3.5 w-3.5" />
            Partner: “that's off by one”
          </m.div>
        </div>
      )}
      {index === 3 && (
        <div className="relative grid h-full place-items-center">
          <svg viewBox="0 0 120 120" className="h-32 w-32 -rotate-90">
            <circle cx="60" cy="60" r="50" className="progress-ring-bg" />
            <m.circle
              cx="60"
              cy="60"
              r="50"
              className="progress-ring"
              initial={{ pathLength: 0 }}
              whileInView={{ pathLength: 0.72 }}
              viewport={{ once: true }}
              transition={{ duration: 1.6, ease: "easeOut" }}
            />
          </svg>
          <div className="absolute text-center">
            <p className="font-mono text-2xl">21:36</p>
            <p className="text-[10px] opacity-60">remaining</p>
          </div>
        </div>
      )}
      {index === 4 && (
        <div className="relative h-full p-5">
          <div className="flex items-center justify-between text-[10px]">
            <span className="flex items-center gap-2">
              <Play className="h-3 w-3" />
              CODE REPLAY
            </span>
            <span className="font-mono opacity-60">09:38</span>
          </div>
          <div className="mt-4 space-y-2 font-mono text-[10px]">
            <p className="opacity-60">if complement in seen:</p>
            <p className="pl-3">return [seen[complement], i]</p>
          </div>
          <div className="relative mt-6 h-1 rounded-full progress-track-line">
            <m.div
              initial={{ width: "0%" }}
              whileInView={{ width: "65%" }}
              viewport={{ once: true }}
              transition={{ duration: 1.4 }}
              className="progress-fill absolute h-1 rounded-full"
            />
          </div>
          <div className="mt-3 flex justify-between font-mono text-[9px] opacity-60">
            <span>Join</span>
            <span>Chat</span>
            <span>Run</span>
            <span>Submit</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function SharedProgress() {
  const section = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const { scrollYProgress } = useScroll({
    target: section,
    offset: ["start end", "end start"],
  });
  const drift = useTransform(scrollYProgress, [0, 0.5], [0.96, 1]);

  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const update = () => {
      const middle = element.getBoundingClientRect().left + element.clientWidth / 2;
      let nearest = 0,
        distance = Infinity;
      Array.from(element.children).forEach((card, i) => {
        const box = card.getBoundingClientRect();
        const d = Math.abs(box.left + box.width / 2 - middle);
        if (d < distance) {
          nearest = i;
          distance = d;
        }
      });
      setActive(nearest);
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      element.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const go = (index: number) => {
    const element = track.current,
      card = element?.children[index];
    if (!element || !(card instanceof HTMLElement)) return;
    element.scrollTo({
      left:
        card.offsetLeft -
        element.offsetLeft -
        (element.clientWidth - card.clientWidth) / 2,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  };

  const reduced = useReducedMotion();
  const visibleOutcomes = [
    outcomes[0],
    outcomes[1],
    ...(features.sessionReplay
      ? [{ ...outcomes[4], title: "Learn from the replay." }]
      : []),
  ].filter((item): item is (typeof outcomes)[number] => Boolean(item));
  const total = visibleOutcomes.length;

  return (
    <section id="progress" ref={section} className="py-24">
      <m.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        className="px-5 text-center"
      >
        <p className="text-xs text-muted-foreground">SHARED PROGRESS</p>
        <h2 className="mt-4 text-3xl font-medium leading-tight md:text-5xl">
          Why practice <span className="font-serif italic font-normal">together?</span>
        </h2>
        <p className="mx-auto mt-4 max-w-md text-sm text-muted-foreground">
          A fresh perspective. A clearer approach. A little more confidence.
        </p>
      </m.div>
      <m.div style={{ scale: reduced ? 1 : drift }}>
        <div
          ref={track}
          role="region"
          aria-label="Benefits of practicing together"
          tabIndex={0}
          className="progress-track relative mt-12 flex snap-x snap-mandatory gap-5 overflow-x-auto pb-8 pt-3 [scrollbar-width:none]"
        >
          {visibleOutcomes.map((item, i) => (
            <m.article
              key={item.title}
              initial={reduced ? false : { opacity: 0, y: 60, rotate: i % 2 ? 2 : -2 }}
              whileInView={{ opacity: 1, y: 0, rotate: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.8, delay: i * 0.1, ease: [0.22, 1, 0.36, 1] }}
              className={`progress-card ${item.tone} relative flex shrink-0 snap-center flex-col rounded-2xl border p-6 transition-[transform,opacity] duration-500 ${active === i ? "is-active" : ""}`}
            >
              <div className="mb-5 flex items-center justify-between">
                <span className="font-mono text-xs text-progress-ink">
                  0{i + 1} / 0{total}
                </span>
                <span className="grid h-9 w-9 place-items-center rounded-full border border-foreground/10 bg-card/70">
                  <item.icon className="h-4 w-4 text-progress-ink" />
                </span>
              </div>
              <Illustration index={i === 2 ? 4 : i} />
              <h3 className="mt-7 text-2xl font-medium leading-tight">{item.title}</h3>
              <p className="mt-3 flex-1 text-sm leading-relaxed text-muted-foreground">
                {item.body}
              </p>
              <div className="mt-6 border-t border-foreground/10 pt-4">
                <span className="flex items-center gap-2 text-xs text-progress-ink">
                  <Check className="h-3.5 w-3.5" />
                  {item.label}
                </span>
              </div>
            </m.article>
          ))}
        </div>
      </m.div>
      <div className="progress-controls mt-4 flex items-center justify-center gap-5">
        <Button
          size="icon"
          variant="outline"
          aria-label="Previous practice benefit"
          disabled={active === 0}
          onClick={() => go(active - 1)}
        >
          <ArrowLeft />
        </Button>
        <span className="font-mono text-sm">
          0{active + 1} / 0{total}
        </span>
        <Button
          size="icon"
          variant="outline"
          aria-label="Next practice benefit"
          disabled={active === total - 1}
          onClick={() => go(active + 1)}
        >
          <ArrowRight />
        </Button>
      </div>
    </section>
  );
}
