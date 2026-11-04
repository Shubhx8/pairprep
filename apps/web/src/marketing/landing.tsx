import { Link } from "react-router-dom";
import "./marketing.css";
import {
  LazyMotion,
  domAnimation,
  m,
  MotionConfig,
  useScroll,
  useTransform,
  useReducedMotion,
  type Variants,
} from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Menu,
  ChevronRight,
  ArrowRight,
  ArrowUpRight,
  Code2,
  GitBranch,
  Terminal,
  ShieldCheck,
  PenLine,
  Calendar,
  FileText,
  MapPin,
  Glasses,
  Check,
  Link2,
  User,
  Users,
  Network,
} from "lucide-react";
import { ProductWorkspace, TwoModes } from "./product-sections.js";
import { SharedProgress } from "./shared-progress.js";
import { Button } from "./button.js";
import { features as flags } from "../config/features.js";
import { routes } from "../config/routes.js";
import { FAQ, InterviewTeaser } from "./extra-sections.js";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "../components/ui/sheet.js";

const heroTerrain = "/images/hero-terrain.webp";
const footerHands = "/images/footer-hands.webp";
const mountains = "/images/mountains.webp";
const painting = "/images/painting-landscape.webp";
const mistBand = "/images/mist-band.webp";
const heroRocks = "/images/hero-rocks-polished.webp";

const fadeUp: Variants = {
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
  const reduced = useReducedMotion();
  return (
    <m.div
      className={className}
      variants={fadeUp}
      initial={reduced ? false : "hidden"}
      whileInView={reduced ? undefined : "show"}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ delay }}
    >
      {children}
    </m.div>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <img
        src="/images/pairprep-logo.png"
        alt=""
        width={32}
        height={32}
        className="h-8 w-8 object-contain"
      />
      PairPrep
    </span>
  );
}

function PrimaryButton({
  children,
  className = "",
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Button
      asChild
      className={`h-auto rounded-xl px-5 py-3 shadow-button transition hover:-translate-y-0.5 ${className}`}
    >
      <Link to={routes.start}>
        {children ?? "Start a practice room"} <ChevronRight className="h-4 w-4" />
      </Link>
    </Button>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
      <span className="h-px w-8 bg-border" /> {children}{" "}
      <span className="h-px w-8 bg-border" />
    </div>
  );
}

function Dots() {
  return (
    <div className="flex gap-1.5">
      <span className="h-3 w-3 rounded-full bg-dot-red" />
      <span className="h-3 w-3 rounded-full bg-dot-yellow" />
      <span className="h-3 w-3 rounded-full bg-dot-green" />
    </div>
  );
}

/* ---------------- NAV ---------------- */
export function Nav({ isSignedIn = false }: { isSignedIn?: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState("");
  const links = [
    ["Product", "/#product"],
    ["Features", "/#features"],
    ...(flags.interviewMode ? [["Interview", routes.interview]] : []),
    ["How it works", routes.howItWorks],
    ["FAQ", "/#faq"],
  ];
  useEffect(() => {
    const update = () => {
      const match = ["product", "features", "how-it-works", "faq"].find((id) => {
        const box = document.getElementById(id)?.getBoundingClientRect();
        return box && box.top <= 180 && box.bottom > 180;
      });
      setActive(match ? `/#${match}` : "");
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  const navLinks = links.map(([label, href]) => (
    <Button
      asChild
      variant="ghost"
      key={href}
      className={`min-h-11 px-3 text-sm ${active === href ? "bg-accent" : "text-muted-foreground"}`}
    >
      <a
        href={href}
        onClick={() => setOpen(false)}
        aria-current={active === href ? "location" : undefined}
      >
        {label}
      </a>
    </Button>
  ));
  return (
    <header className="fixed inset-x-0 top-0 z-50 px-4 pt-4 md:px-8">
      <div className="navigation-shell mx-auto max-w-[84rem] rounded-lg border px-4 py-3 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <Link to="/" aria-label="PairPrep home">
            <Logo />
          </Link>
          <nav aria-label="Main navigation" className="hidden items-center xl:flex">
            {navLinks}
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" className="hidden sm:inline-flex">
              <Link to={isSignedIn ? routes.dashboard : routes.signIn}>
                {isSignedIn ? "Dashboard" : "Sign in"}
              </Link>
            </Button>
            <Button asChild className="hidden sm:inline-flex">
              <Link to={routes.start}>Start a practice room</Link>
            </Button>
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="min-h-11 min-w-11 xl:hidden"
                  aria-label="Open navigation"
                >
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent side="top" className="marketing">
                <SheetTitle>PairPrep</SheetTitle>
                <SheetDescription className="sr-only">Main navigation</SheetDescription>
                <nav aria-label="Mobile navigation" className="mt-5 grid">
                  {navLinks}
                  <Button asChild variant="ghost">
                    <Link to={isSignedIn ? routes.dashboard : routes.signIn}>
                      {isSignedIn ? "Dashboard" : "Sign in"}
                    </Link>
                  </Button>
                  <Button asChild>
                    <Link to={routes.start}>Start a practice room</Link>
                  </Button>
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </header>
  );
}

/* ---------------- HERO ---------------- */
function Hero() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end start"],
  });
  const bgY = useTransform(scrollYProgress, [0, 1], ["0%", "18%"]);
  const cardY = useTransform(scrollYProgress, [0, 0.7], ["0%", "10%"]);
  const cardScale = useTransform(scrollYProgress, [0, 0.55], [0.94, 1.08]);
  const cardRotate = useTransform(scrollYProgress, [0, 0.5], [14, 0]);
  const rocksY = useTransform(scrollYProgress, [0, 1], ["0%", "-8%"]);
  const glow = useTransform(scrollYProgress, [0, 0.5], [0.35, 0.8]);

  return (
    <section id="top" ref={ref} className="relative overflow-x-clip pb-10">
      <m.img
        src={heroTerrain}
        srcSet="/images/hero-terrain-960w.webp 960w, /images/hero-terrain.webp 1920w"
        sizes="100vw"
        alt=""
        width={1920}
        height={1088}
        fetchPriority="high"
        decoding="async"
        style={{ y: reduced ? 0 : bgY }}
        className="hero-terrain absolute inset-x-0 bottom-0 h-[72%] w-full object-cover object-[50%_35%] opacity-90"
      />
      <div className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-background via-background/80 to-transparent" />
      <div className="relative z-10 mx-auto max-w-7xl px-5 pt-36 text-center md:pt-40">
        <Reveal>
          <Eyebrow>COLLABORATIVE CODING & INTERVIEW PREPARATION</Eyebrow>
        </Reveal>
        <Reveal delay={0.1}>
          <h1 className="mt-6 text-4xl font-medium leading-[1.05] tracking-tight md:text-6xl">
            Practice together.
            <br />
            <span className="font-serif italic font-normal">
              Interview with confidence.
            </span>
          </h1>
        </Reveal>
        <Reveal delay={0.2}>
          <p className="mx-auto mt-6 max-w-md text-sm leading-relaxed text-muted-foreground md:text-base">
            A shared coding room for you and a partner. Write code together, run it
            instantly, and rehearse real technical interviews with timers, hidden tests
            and feedback.
          </p>
        </Reveal>
        <Reveal
          delay={0.3}
          className="mt-8 flex flex-wrap items-center justify-center gap-4 sm:gap-6"
        >
          <PrimaryButton>Explore practice</PrimaryButton>
          <Button asChild variant="link">
            <a href={routes.howItWorks}>
              See how it works <ChevronRight className="h-4 w-4" />
            </a>
          </Button>
        </Reveal>

        <p className="mt-4 text-sm text-muted-foreground">
          Free · Runs in your browser · Join with a link, no install
        </p>
        <p className="sr-only">
          Illustrative shared Python editor with two named cursors and output [0, 1].
        </p>
        <div aria-hidden="true" className="mt-20 [perspective:1600px] md:mt-28">
          <m.div
            initial={{ opacity: 0, y: -120, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 1.3, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            <m.div
              style={{
                y: reduced ? 0 : cardY,
                scale: reduced ? 1 : cardScale,
                rotateX: reduced ? 0 : cardRotate,
                transformOrigin: "50% 100%",
              }}
              className="hero-room glass-panel shadow-float relative mx-auto max-w-6xl rounded-3xl p-5 pb-40 text-left text-panel-foreground md:p-7 md:pb-64"
            >
              <m.div
                aria-hidden
                style={{ opacity: glow }}
                className="hero-room-glow pointer-events-none absolute -inset-px rounded-3xl"
              />
              <div className="relative flex flex-wrap items-center justify-between gap-3">
                <Dots />
                <span className="text-[10px] text-panel-muted">
                  Practice · Product preview
                </span>
              </div>
              <div className="relative mt-5 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                <div>
                  <h3 className="text-xl md:text-2xl">PairPrep · Practice room</h3>
                  <p className="mt-1 text-xs text-panel-muted">
                    A shared space to think, code and grow together
                  </p>
                </div>
                <div className="flex flex-wrap gap-3 font-mono text-[11px]">
                  {["PYTHON · PRACTICE ROOM", "YOU + YOUR PARTNER · CONNECTED"].map(
                    (t) => (
                      <div
                        key={t}
                        className="glass-inner flex items-center gap-3 rounded-full py-1.5 pl-4 pr-1.5"
                      >
                        {t}
                        <span className="flex items-center gap-1 rounded-full bg-panel-inner px-2.5 py-1 font-sans">
                          Together <Check className="h-3 w-3" />
                        </span>
                      </div>
                    )
                  )}
                </div>
              </div>
              <div className="relative mt-5 grid gap-4 md:grid-cols-[1fr_1.15fr]">
                <div className="glass-inner rounded-2xl p-4">
                  <div className="flex flex-wrap gap-2 text-sm">
                    {[
                      [PenLine, "Write code"],
                      [Calendar, "Python"],
                      [FileText, "C++"],
                      [MapPin, "JavaScript"],
                      [Glasses, "Partners"],
                    ].map(([I, l], i) => {
                      const Icon = I as typeof PenLine;
                      return (
                        <span
                          key={l as string}
                          className={`flex items-center gap-1.5 rounded-lg px-3 py-2 ${
                            i === 0 ? "bg-panel-inner" : "text-panel-muted"
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" /> {l as string}
                        </span>
                      );
                    })}
                  </div>
                  <div className="glass-inner mt-4 rounded-xl p-4 text-sm">
                    <p className="text-[10px] text-panel-muted">PROBLEM · TWO SUM</p>
                    <p className="border-panel-foreground mt-2 border-l pl-2 font-medium">
                      Find two numbers that add up to the target.
                    </p>
                    <p className="font-mono text-[11px] text-panel-muted mt-3">
                      nums = [2, 7, 11, 15] target = 9
                    </p>
                  </div>
                </div>
                <div className="glass-inner rounded-2xl p-4 font-mono text-xs">
                  <div className="flex items-center justify-between">
                    <p>two-sum.py</p>
                    <span className="flex items-center gap-1 text-[10px] text-success">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
                      Live
                    </span>
                  </div>
                  <div className="glass-inner mt-4 space-y-1.5 whitespace-pre rounded-xl p-4 leading-relaxed font-mono">
                    <p>
                      <span className="text-panel-muted">1</span> def two_sum(nums,
                      target):
                    </p>
                    <p>
                      <span className="text-panel-muted">2</span> seen = &#123;&#125;
                    </p>
                    <p>
                      <span className="text-panel-muted">3</span> for i, num in
                      enumerate(nums):
                    </p>
                    <p className="relative">
                      <span className="text-panel-muted">4</span> complement = target -
                      num
                      <span className="bg-dot-yellow ml-1 inline-block h-3 w-px animate-pulse align-middle" />
                      <span className="bg-dot-yellow font-sans text-[9px] text-primary ml-1 rounded-sm px-1">
                        Partner
                      </span>
                    </p>
                    <p>
                      <span className="text-panel-muted">5</span> if complement in seen:
                    </p>
                    <p>
                      <span className="text-panel-muted">6</span> return
                      [seen[complement], i]
                      <span className="bg-dot-red font-sans text-[9px] text-primary-foreground ml-1 rounded-sm px-1">
                        You
                      </span>
                    </p>
                  </div>
                  <p className="mt-4 flex items-center gap-2">
                    <span className="bg-dot-red h-3 w-1.5 animate-pulse" /> Output: [0, 1]
                  </p>
                </div>
              </div>
            </m.div>
          </m.div>
        </div>
      </div>
      <m.img
        src={heroRocks}
        srcSet="/images/hero-rocks-polished-960w.webp 960w, /images/hero-rocks-polished.webp 1920w"
        sizes="100vw"
        alt=""
        width={1920}
        height={640}
        decoding="async"
        style={{ y: reduced ? 0 : rocksY }}
        className="hero-rocks pointer-events-none absolute inset-x-0 -bottom-28 z-20 w-full min-w-[900px] object-cover object-bottom md:-bottom-36"
      />
    </section>
  );
}

/* ---------------- ABOUT + MARQUEE ---------------- */
const logos = [
  "Python",
  "C++",
  "JavaScript",
  "Shared editing",
  "Live cursors",
  "Author colors",
  "Instant code execution",
  "Room links",
  ...(flags.interviewMode ? ["Mock interviews"] : []),
  ...(flags.sessionReplay ? ["Session replay"] : []),
  ...(flags.scorecard ? ["Scorecards"] : []),
  "Themes and fonts",
].map((name) => [Code2, name] as const);

/* Soft mist that bridges the hero stones into the About section */
function HeroTransition() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const y = useTransform(scrollYProgress, [0, 1], ["-30%", "20%"]);
  const x = useTransform(scrollYProgress, [0, 1], ["-3%", "3%"]);
  const opacity = useTransform(scrollYProgress, [0, 0.35, 0.65, 1], [0, 0.4, 0.4, 0]);
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none relative z-10 h-40 overflow-hidden md:h-56"
    >
      <div className="hero-mist-drift absolute inset-0">
        <m.img
          src={mistBand}
          alt=""
          loading="lazy"
          decoding="async"
          width={1920}
          height={640}
          style={{
            y: reduced ? 0 : y,
            x: reduced ? 0 : x,
            opacity: reduced ? 0.7 : opacity,
          }}
          className="mask-band absolute inset-0 h-full w-[110%] max-w-none object-cover mix-blend-multiply"
        />
      </div>
    </div>
  );
}

function About() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "start 35%"],
  });
  const y = useTransform(scrollYProgress, [0, 1], [90, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [0.97, 1]);
  const opacity = useTransform(scrollYProgress, [0, 0.6, 1], [0, 0.85, 1]);
  const blur = useTransform(scrollYProgress, [0, 0.7], ["blur(6px)", "blur(0px)"]);

  return (
    <section
      id="about"
      ref={ref}
      className="section-auto relative z-40 mx-auto max-w-[88rem] px-5 pt-16 pb-24 md:px-10 md:pt-24"
    >
      <m.div style={reduced ? {} : { y, scale, opacity, filter: blur }}>
        <div className="grid items-center gap-10 md:grid-cols-[1.4fr_1fr]">
          <Reveal>
            <p className="text-xs text-muted-foreground">About PairPrep —</p>
            <h2 className="mt-4 text-3xl font-medium leading-tight tracking-tight md:text-4xl">
              From pair programming to{" "}
              <span className="font-serif italic font-normal">
                real interview preparation.
              </span>
            </h2>
            <p className="mt-5 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Coding alone teaches you the answer. Coding with someone teaches you to
              explain it. PairPrep puts you and a partner in one live editor so you can
              think out loud, compare approaches and get used to the pressure of a real
              interview.
            </p>
            <PrimaryButton className="mt-8">Discover PairPrep</PrimaryButton>
            <div className="mt-5 flex flex-wrap gap-4 text-sm">
              {[
                "Explain your thinking",
                "Compare approaches",
                "Build interview confidence",
              ].map((text) => (
                <span key={text} className="flex items-center gap-2">
                  <Check className="h-4 w-4" />
                  {text}
                </span>
              ))}
            </div>
            <p className="mt-5 text-sm text-muted-foreground">
              Built for students, study groups and interview candidates.
            </p>
          </Reveal>
          <Reveal delay={0.15}>
            <div className="shadow-soft relative overflow-hidden rounded-3xl">
              <img
                src={mountains}
                alt="Misty mountain range"
                loading="lazy"
                decoding="async"
                width={1600}
                height={912}
                className="h-72 w-full object-cover"
              />
              <m.div
                initial={{ y: 30, opacity: 0 }}
                whileInView={{ y: 0, opacity: 1 }}
                viewport={{ once: true }}
                transition={{ delay: 0.4, duration: 0.8 }}
                className="glass-panel shadow-float text-panel-foreground absolute bottom-6 left-1/2 w-56 -translate-x-1/2 rounded-2xl p-4"
              >
                <Dots />
                <p className="mt-4 text-3xl">Together</p>
                <p className="text-sm">Better practice</p>
                <p className="mt-2 text-[11px] text-panel-muted">
                  Bring a partner, share ideas and work through a coding problem in the
                  same workspace.
                </p>
              </m.div>
            </div>
          </Reveal>
        </div>
      </m.div>
      <div
        tabIndex={0}
        aria-label="Supported languages and capabilities"
        className="marketing-marquee fade-x mt-20 overflow-hidden"
      >
        <div className="animate-marquee flex w-max gap-14 text-muted-foreground grayscale">
          {[...logos, ...logos, ...logos, ...logos].map(([Icon, name], i) => (
            <span key={i} className="flex items-center gap-2 text-lg">
              <Icon className="h-5 w-5" />
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- CAPABILITIES ---------------- */
const capabilities = [
  {
    icon: Code2,
    title: "Shared live editor",
    body: "Everyone edits the same code at the same time. No conflicts, no overwriting, even on a weak connection.",
  },
  {
    icon: GitBranch,
    title: "See who wrote what",
    body: "Switch on author colours to see each person's contribution, live and in the final summary.",
  },
  {
    icon: Terminal,
    title: "Run code instantly",
    body: "Python, C++ and JavaScript run in isolated, time-limited sandboxes. Output is shared with the whole room.",
  },
  {
    icon: Link2,
    title: "Join with a link",
    body: "Create a room with Google or GitHub. Your partner joins as a guest with just the link.",
  },
  {
    icon: PenLine,
    title: "Make it yours",
    body: "Eight themes, six coding fonts and adjustable text size. Your settings only change your own screen.",
  },
  ...(flags.interviewMode
    ? [
        {
          icon: ShieldCheck,
          title: "Mock interview mode",
          body: "Interviewer and candidate roles, a shared timer, hidden test cases and a structured scorecard.",
        },
      ]
    : []),
];

function Capabilities() {
  return (
    <section id="features" className="section-auto relative py-24">
      <div className="mx-auto max-w-[88rem] px-5 md:px-10">
        <div className="grid gap-6 md:grid-cols-2 md:items-end">
          <Reveal>
            <p className="text-xs text-muted-foreground">Capabilities —</p>
            <h2 className="mt-4 text-3xl font-medium leading-tight tracking-tight md:text-4xl">
              Everything that makes
              <br />
              practice count.
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="max-w-xs text-sm text-muted-foreground md:ml-auto">
              Live editing, instant execution and structured interview tools in one room.
            </p>
          </Reveal>
        </div>
        <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {capabilities.map((f, i) => (
            <Reveal key={f.title} delay={i * 0.08}>
              <div className="shadow-soft group h-full rounded-3xl border bg-card p-6 transition hover:-translate-y-1">
                <div className="flex items-center justify-between">
                  <span className="grid h-10 w-10 place-items-center rounded-xl border bg-muted">
                    <f.icon className="h-4 w-4" />
                  </span>
                  {f.title === "Mock interview mode" && (
                    <Button asChild variant="link">
                      <Link to={routes.interview}>See interview mode</Link>
                    </Button>
                  )}
                </div>
                <h3 className="mt-8 text-lg font-medium">{f.title}</h3>
                <p className="mt-2 max-w-sm text-sm text-muted-foreground">{f.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- WORKSPACE ---------------- */
function Workspace() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const imgY = useTransform(scrollYProgress, [0, 1], ["-10%", "10%"]);
  const cardScale = useTransform(scrollYProgress, [0, 0.45], [0.92, 1]);
  const cardRot = useTransform(scrollYProgress, [0, 0.45], [12, 0]);
  return (
    <section
      id="product"
      className="section-auto relative mx-auto max-w-[88rem] px-5 py-24 md:px-10"
    >
      <Reveal className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground">Inside PairPrep —</p>
          <h2 className="mt-4 text-3xl font-medium leading-tight tracking-tight md:text-5xl">
            A workspace for
            <br />
            <span className="font-serif italic font-normal">thinking out loud.</span>
          </h2>
        </div>
        <PrimaryButton />
      </Reveal>
      <div
        ref={ref}
        className="shadow-float relative mt-10 overflow-hidden rounded-[2rem] [perspective:1600px]"
      >
        <m.img
          src={painting}
          alt="Misty mountain lake painting"
          loading="lazy"
          decoding="async"
          width={1920}
          height={912}
          style={{ y: reduced ? 0 : imgY, scale: 1.2 }}
          className="h-[550px] w-full object-cover sm:h-[600px]"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-foreground/40 via-transparent to-foreground/10" />
        <div className="absolute inset-0 grid place-items-center p-4 sm:p-10">
          <m.div
            style={{ scale: reduced ? 1 : cardScale, rotateX: reduced ? 0 : cardRot }}
            className="w-full max-w-4xl"
          >
            <ProductWorkspace />
          </m.div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- PROCESS ---------------- */
const steps = [
  {
    n: "01",
    title: "Create",
    body: "Sign in with Google or GitHub, pick a language and create your room.",
    input: "Practice room",
    btn: "Create room",
    mock: (
      <div className="font-mono text-[11px] leading-relaxed">
        <p className="text-panel-foreground">PairPrep / New practice room</p>
        <p className="text-panel-muted">✓ Choose a practice problem</p>
        <p className="text-panel-muted">✓ Select your programming language</p>
        <p className="text-dot-yellow">✓ Set up your shared workspace</p>
        <p className="text-success">✓ Ready to invite a partner</p>
      </div>
    ),
  },
  {
    n: "02",
    title: "Invite",
    body: "Copy the room link and send it to your partner. They join in one click.",
    input: "Room link",
    btn: "Share",
    mock: (
      <div className="space-y-2 text-[11px]">
        <div className="glass-inner rounded-lg p-2.5">
          <p className="font-medium text-panel-foreground">Invite your partner</p>
          <p className="text-panel-muted">"Let’s work through this problem together."</p>
        </div>
        <div className="glass-inner rounded-lg p-2.5">
          <p className="font-medium text-panel-foreground">Join the same workspace</p>
          <p className="text-panel-muted">
            Bring your ideas and your preferred approach.
          </p>
        </div>
      </div>
    ),
  },
  {
    n: "03",
    title: "Practice",
    body: "Write code together, run it, talk it through, then review how it came together.",
    input: "Practice session",
    btn: "Together",
    mock: (
      <div className="grid h-full place-items-center">
        <span className="shadow-float grid h-20 w-20 place-items-center rounded-full bg-panel-foreground">
          <svg viewBox="0 0 24 24" className="fill-primary h-9 w-9">
            <path d="M2 2h7l3 4 3-4h7v7l-4 3 4 3v7h-7l-3-4-3 4H2v-7l4-3-4-3z" />
          </svg>
        </span>
      </div>
    ),
  },
];

function Process() {
  const [active, setActive] = useState(0);
  const [line, setLine] = useState({ top: 0, height: 0, fill: 0 });
  const wrap = useRef<HTMLDivElement>(null);
  const nodes = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const w = wrap.current;
      if (!w) return;
      const wTop = w.getBoundingClientRect().top;
      const centers = nodes.current.map((n) => {
        const r = n?.getBoundingClientRect();
        if (!r) return 0;
        return r.top + r.height / 2;
      });
      const mid = window.innerHeight / 2;
      let a = 0;
      centers.forEach((c, i) => {
        if (c <= mid) a = i;
      });
      setActive(a);
      const first = centers[0] ?? 0,
        last = centers[centers.length - 1] ?? 0;
      setLine({
        top: first - wTop,
        height: last - first,
        fill: Math.min(Math.max(mid - first, 0), last - first),
      });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <section id="how-it-works" className="section-auto relative py-24">
      <div className="mx-auto max-w-6xl px-5 md:px-10">
        <Reveal className="text-center">
          <Eyebrow>Practice</Eyebrow>
          <h2 className="mt-4 text-3xl font-medium leading-tight tracking-tight md:text-4xl">
            From first idea to solved problem
            <br />
            in 3 simple steps.
          </h2>
          <p className="mt-4 text-muted-foreground">
            Setting up takes less than a minute.
          </p>
        </Reveal>
        <div ref={wrap} className="relative mt-16">
          <div
            className="absolute left-4 w-px -translate-x-1/2 bg-border md:left-6"
            style={{ top: line.top, height: line.height }}
          />
          <div
            className="absolute left-4 w-px -translate-x-1/2 bg-primary md:left-6"
            style={{ top: line.top, height: line.fill }}
          />
          <div className="space-y-10">
            {steps.map((s, i) => {
              const on = i === active;
              return (
                <div
                  key={s.n}
                  className="relative grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-4 md:grid-cols-[3rem_minmax(0,1fr)]"
                >
                  <span
                    ref={(el) => {
                      nodes.current[i] = el;
                    }}
                    className={`relative z-10 grid h-8 w-8 place-items-center rounded-full text-[11px] font-medium transition-all duration-500 ease-out md:h-12 md:w-12 md:text-xs ${on ? "shadow-button scale-110 bg-primary text-primary-foreground" : "border bg-background text-muted-foreground"}`}
                  >
                    {s.n}
                  </span>
                  <div
                    className={`shadow-soft grid gap-4 rounded-3xl border bg-card p-3 transition-all duration-500 ease-out md:grid-cols-2 ${on ? "scale-100 opacity-100" : "scale-[0.97] opacity-100"}`}
                  >
                    <div className="relative min-h-40 overflow-hidden rounded-2xl">
                      <img
                        src={i === 2 ? heroTerrain : i === 1 ? painting : mountains}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                      <p className="sr-only">
                        Illustrative {s.title.toLowerCase()} step.
                      </p>
                      <div
                        aria-hidden="true"
                        className="glass-panel relative m-3 h-[calc(100%-1.5rem)] rounded-xl p-3"
                      >
                        {s.mock}
                      </div>
                    </div>
                    <div className="flex flex-col justify-between p-3">
                      <div>
                        <h3 className="font-medium">{s.title}</h3>
                        <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>
                      </div>
                      <div className="mt-6 flex items-center justify-between rounded-xl bg-muted px-3 py-2 text-xs">
                        <span className="font-mono text-muted-foreground">{s.input}</span>
                        <span className="shadow-soft rounded-lg bg-card px-3 py-1">
                          {s.btn}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- AUDIENCE ---------------- */
const audience = [
  {
    icon: User,
    title: "Students preparing for placements",
    body: "Practice coding rounds with a partner before the real one.",
  },
  {
    icon: Users,
    title: "Study groups and coding partners",
    body: "Solve problems together in one shared workspace.",
  },
  {
    icon: Network,
    title: "Interviewers and candidates",
    body: "Run realistic mock interviews with roles, timers and structured feedback.",
  },
];

function Audience() {
  return (
    <section className="section-auto mx-auto max-w-[88rem] px-5 py-24 md:px-10">
      <Reveal className="text-center">
        <Eyebrow>Who it's for</Eyebrow>
        <h2 className="mt-4 text-3xl font-medium leading-tight tracking-tight md:text-4xl">
          Built for developers
          <br />
          who grow together.
        </h2>
      </Reveal>
      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {audience
          .filter((_, i) => i < 2 || flags.interviewMode)
          .map((a, i) => (
            <Reveal key={a.title} delay={i * 0.08}>
              <div className="shadow-soft h-full rounded-3xl border bg-card p-6">
                <span className="grid h-10 w-10 place-items-center rounded-xl border bg-muted">
                  <a.icon className="h-4 w-4" />
                </span>
                <h3 className="mt-8 font-medium">{a.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{a.body}</p>
                <Button asChild variant="link" className="mt-3 px-0">
                  <Link to={routes.start}>
                    Start practicing <ArrowUpRight />
                  </Link>
                </Button>
              </div>
            </Reveal>
          ))}
      </div>
    </section>
  );
}

/* ---------------- FOOTER ---------------- */
export function Footer() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end end"],
  });
  const handsY = useTransform(scrollYProgress, [0, 1], [55, 0]);
  const markY = useTransform(scrollYProgress, [0, 1], [65, 0]);
  const cols = [
    {
      title: "Product",
      links: [
        ["Overview", "/#product"],
        ["Features", "/#features"],
        ["How it works", routes.howItWorks],
        ["FAQ", "/#faq"],
      ],
    },
    {
      title: "Practice",
      links: ["Python", "C++", "JavaScript"].map((label) => [label, routes.start]),
    },
    ...(flags.interviewMode
      ? [
          {
            title: "Interview",
            links: [
              ["Mock interviews", routes.interview],
              ...(flags.sessionReplay
                ? [["Session replay", `${routes.interview}#feedback`]]
                : []),
              ...(flags.scorecard ? [["Scorecard", `${routes.interview}#feedback`]] : []),
            ],
          },
        ]
      : []),
    {
      title: "Company",
      links: [
        ["Privacy", routes.privacy],
        ["Terms", routes.terms],
        ["Contact", routes.contact],
      ],
    },
  ];
  return (
    <footer ref={ref} className="pairprep-footer relative overflow-hidden">
      <div className="relative mx-auto max-w-[88rem] px-5 pt-20 md:px-10 md:pt-28">
        <div className="relative grid min-h-[390px] items-start gap-10 md:grid-cols-2">
          <Reveal className="relative z-10 max-w-md pt-6">
            <span className="inline-flex items-center gap-2 rounded-full border bg-card/50 px-3 py-1.5 text-[11px] text-muted-foreground">
              <Code2 className="h-3.5 w-3.5" /> Built together
            </span>
            <h2 className="mt-5 text-4xl font-medium leading-tight md:text-5xl">
              Your next breakthrough
              <br />
              <span className="font-serif italic font-normal">starts together.</span>
            </h2>
            <p className="mt-5 max-w-xs text-sm leading-relaxed text-muted-foreground">
              Create a room in seconds, send the link and start solving.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button asChild className="shadow-button h-11 rounded-xl px-5">
                <Link to={routes.start}>
                  Start a practice room <ArrowRight />
                </Link>
              </Button>
              {flags.interviewMode && (
                <Button asChild variant="link" className="px-0">
                  <Link to={routes.interview}>
                    Set up a mock interview <ArrowUpRight />
                  </Link>
                </Button>
              )}
            </div>
          </Reveal>
          <m.div
            initial={{ opacity: 0, y: 40, rotate: -5 }}
            whileInView={{ opacity: 1, y: 0, rotate: -5 }}
            viewport={{ once: true }}
            transition={{ duration: 0.9 }}
            className="footer-editor shadow-soft pointer-events-none relative mt-5 w-full overflow-hidden rounded-lg border bg-card/70"
            aria-hidden="true"
          >
            <div className="flex items-center justify-between border-b px-4 py-3">
              <span className="flex items-center gap-2 text-xs">
                <Code2 className="h-4 w-4" /> PairPrep / practice.py
              </span>
              <span className="text-[10px] text-muted-foreground">Python</span>
            </div>
            <div className="grid grid-cols-[110px_1fr] sm:grid-cols-[140px_1fr]">
              <div className="border-r bg-secondary/40 px-4 py-5 text-[11px] leading-8 text-muted-foreground">
                <p className="font-medium text-foreground">Practice room</p>
                <p>⌄ Two sum</p>
                <p className="pl-3">Your approach</p>
                <p className="pl-3">practice.py</p>
                <p className="mt-5 font-medium text-foreground">Participants</p>
                <p>You</p>
                <p>Your partner</p>
              </div>
              <div className="overflow-hidden px-4 py-5 font-mono text-[11px] leading-7 text-muted-foreground">
                <p className="text-foreground">def two_sum(nums, target):</p>
                <p> seen = &#123;&#125;</p>
                <p> for i, num in enumerate(nums):</p>
                <p> complement = target - num</p>
                <p className="text-foreground"> if complement in seen:</p>
                <p> return [seen[complement], i]</p>
                <p> seen[num] = i</p>
                <p className="text-success mt-4"># Think it through. Together.</p>
              </div>
            </div>
          </m.div>
        </div>
        <div className="relative z-10 mt-12 grid gap-10 border-t border-foreground/10 pt-10 md:grid-cols-[1.5fr_2fr_1fr]">
          <Reveal>
            <Logo />
            <p className="mt-4 max-w-56 text-xs leading-relaxed text-muted-foreground">
              A shared coding workspace for programming practice and technical interview
              preparation.
            </p>
          </Reveal>
          <Reveal delay={0.1} className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            {cols.map((col) => (
              <div key={col.title}>
                <h3 className="font-medium">{col.title}</h3>
                <ul className="mt-4 space-y-3 text-muted-foreground">
                  {col.links.map(([label, href]) => (
                    <li key={label}>
                      <a href={href} className="transition-colors hover:text-foreground">
                        {label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Reveal>
          <Reveal delay={0.2}>
            <h3 className="text-xs font-medium">One workspace. Shared progress.</h3>
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              A little practice.
              <br />A fresh perspective.
            </p>
            <Button
              asChild
              variant="outline"
              className="mt-4 h-9 rounded-lg bg-card/50 text-xs"
            >
              <a href={routes.howItWorks}>
                See how it works <ArrowUpRight />
              </a>
            </Button>
          </Reveal>
        </div>
      </div>
      <div className="relative mt-12 h-[235px] md:mt-16 md:h-[380px]">
        <m.p
          style={{ y: reduced ? 0 : markY }}
          className="footer-wordmark pointer-events-none absolute z-0 inset-x-0 -bottom-3 select-none text-center font-medium leading-none text-foreground/10"
        >
          PairPrep
        </m.p>
        <m.img
          src={footerHands}
          alt=""
          loading="lazy"
          decoding="async"
          width={1536}
          height={512}
          style={{ y: reduced ? 0 : handsY }}
          className="pointer-events-none absolute z-10 inset-x-0 top-0 w-full max-w-none"
        />
        <p className="relative z-20 mx-auto pt-12 text-center text-[10px] leading-5 text-muted-foreground md:pt-20">
          © 2026 PairPrep
          <br />
          Practice. Share. Grow.
        </p>
      </div>
    </footer>
  );
}

/* ---------------- SECTION TRANSITION ---------------- */
function MistBand({ flip = false }: { flip?: boolean }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const y = useTransform(scrollYProgress, [0, 1], ["-25%", "25%"]);
  const x = useTransform(scrollYProgress, [0, 1], flip ? ["4%", "-4%"] : ["-4%", "4%"]);
  const opacity = useTransform(scrollYProgress, [0, 0.4, 0.6, 1], [0, 0.9, 0.9, 0]);
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none relative -my-24 h-64 overflow-hidden md:-my-32 md:h-96"
    >
      <m.img
        src={mistBand}
        alt=""
        loading="lazy"
        decoding="async"
        width={1920}
        height={640}
        style={{
          y: reduced ? 0 : y,
          x: reduced ? 0 : x,
          opacity: reduced ? 0.9 : opacity,
          scaleX: flip ? -1 : 1,
        }}
        className="mask-band absolute inset-0 h-full w-[110%] max-w-none object-cover mix-blend-multiply"
      />
    </div>
  );
}

export function Landing() {
  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user">
        <div className="marketing">
          <a href="#main-content" className="skip-link">
            Skip to content
          </a>
          <Nav />
          <main id="main-content" className="page-bg overflow-x-hidden">
            <Hero />
            <HeroTransition />
            <About />
            <MistBand />
            <Workspace />
            <Capabilities />
            <TwoModes />
            <MistBand flip />
            <Process />
            {flags.interviewMode && <InterviewTeaser />}
            <MistBand />
            <Audience />
            <SharedProgress />
            <MistBand flip />
            <FAQ />
            <p className="px-5 text-center text-sm text-muted-foreground">
              Interface previews are illustrative.
            </p>
          </main>
          <Footer />
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}

export default Landing;
