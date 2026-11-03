import { Link } from "react-router-dom";
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from "framer-motion";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  FileCode2,
  Folder,
  FolderOpen,
  MessageCircle,
  Play,
  Search,
  Terminal,
  Timer,
  Users,
  Info,
} from "lucide-react";
import { Logo } from "./landing.js";
import { routes } from "../config/routes.js";

const natureBg = "/images/auth-nature.jpg";

export type AuthMode = "signup" | "login";

const ease = [0.22, 1, 0.36, 1] as const;

const solution = `def two_sum(nums, target):
    seen = {}
    for i, num in enumerate(nums):
        complement = target - num
        if complement in seen:
            return [seen[complement], i]
        seen[num] = i
    return []`;

const tree: {
  name: string;
  depth: number;
  folder?: boolean;
  open?: boolean;
  active?: boolean;
}[] = [
  { name: "arrays", depth: 0, folder: true, open: true },
  { name: "two_sum.py", depth: 1, active: true },
  { name: "three_sum.py", depth: 1 },
  { name: "graphs", depth: 0, folder: true },
  { name: "dynamic-programming", depth: 0, folder: true },
  { name: "tests", depth: 0, folder: true, open: true },
  { name: "test_two_sum.py", depth: 1 },
  { name: "notes.md", depth: 0 },
  { name: "interview-plan.md", depth: 0 },
];

function highlight(line: string) {
  const parts = line.split(/(\bdef\b|\bfor\b|\bin\b|\bif\b|\breturn\b|\benumerate\b)/g);
  return parts.map((p, i) =>
    /^(def|for|in|if|return)$/.test(p) ? (
      <span key={i} className="text-roadmap">
        {p}
      </span>
    ) : p === "enumerate" ? (
      <span key={i} className="text-success">
        {p}
      </span>
    ) : (
      p
    )
  );
}

function useTyped(text: string) {
  const reduced = useReducedMotion();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (reduced) {
      setCount(text.length);
      return;
    }
    let n = 0;
    let pause = 0;
    const id = window.setInterval(() => {
      if (n >= text.length) {
        pause += 1;
        if (pause > 60) {
          n = 0;
          pause = 0;
        }
        setCount(n);
        return;
      }
      n += 1;
      setCount(n);
    }, 45);
    return () => window.clearInterval(id);
  }, [text, reduced]);
  return text.slice(0, count);
}

function TypedCode() {
  const typed = useTyped(solution);
  const lines = typed.split("\n");
  const total = solution.split("\n").length;
  const isFinished = typed.length >= solution.length;

  return (
    <>
      <div className="flex-1 overflow-hidden py-3 font-mono text-[11px] leading-6">
        {Array.from({ length: total + 4 }).map((_, i) => {
          const line = lines[i];
          const isCursor = i === lines.length - 1;
          return (
            <div key={i} className="flex min-w-max gap-4 pr-4">
              <span className="text-panel-muted/50 w-6 shrink-0 select-none text-right">
                {i + 1}
              </span>
              <span className="relative whitespace-pre">
                {line !== undefined ? highlight(line) : ""}
                {isCursor && (
                  <>
                    <span className="bg-success ml-px inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse" />
                    <span className="bg-success text-primary absolute left-full top-full ml-1 whitespace-nowrap rounded px-1 text-[8px]">
                      Partner
                    </span>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div className="border-panel-muted/20 border-t px-4 py-2.5 font-mono text-[10px]">
        <span className="text-panel-muted">OUTPUT</span>
        <AnimatePresence mode="wait">
          {isFinished ? (
            <motion.span
              key="ok"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-success ml-3"
            >
              ✓ 3 / 3 tests passed · [0, 1]
            </motion.span>
          ) : (
            <motion.span
              key="wait"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-panel-muted ml-3"
            >
              waiting for run…
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

function CodingScreen() {
  const objectives = [
    "Agree on an approach",
    "Write the solution together",
    "Run hidden test cases",
  ];
  return (
    <div aria-hidden="true" className="relative h-full min-h-[470px]">
      {/* Session brief card, behind the editor */}
      <motion.div
        initial={{ opacity: 0, x: -30 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.9, delay: 0.5, ease }}
        className="glass-panel text-panel-foreground absolute bottom-8 left-0 top-12 z-10 w-[40%] rounded-2xl p-5 pr-10"
      >
        <div className="mb-5 flex gap-1.5">
          <span className="bg-dot-red h-2.5 w-2.5 rounded-full" />
          <span className="bg-dot-yellow h-2.5 w-2.5 rounded-full" />
          <span className="bg-dot-green h-2.5 w-2.5 rounded-full" />
        </div>
        <p className="font-serif text-2xl leading-tight">
          Practicing <span className="italic">Two Sum</span>
        </p>
        <p className="text-panel-muted mt-3 text-xs leading-relaxed">
          You and your partner share one editor, one timer and one conversation. Talk
          through the approach, then code it together.
        </p>
        <p className="mt-5 text-xs font-medium">Session goals</p>
        <ul className="mt-3 space-y-2.5">
          {objectives.map((o) => (
            <li key={o} className="flex items-center gap-2.5 text-xs">
              <span className="border-success bg-success/20 text-success flex h-4 w-4 shrink-0 items-center justify-center rounded border">
                <Check className="h-3 w-3" />
              </span>
              <span className="text-panel-foreground">{o}</span>
            </li>
          ))}
        </ul>
        <div className="glass-inner absolute bottom-5 left-5 right-10 rounded-xl p-3">
          <p className="text-panel-muted text-[11px]">Message your partner…</p>
          <div className="mt-2 flex items-center justify-between text-[10px]">
            <span className="flex items-center gap-1.5">
              <Users className="text-success h-3 w-3" />2 in room
            </span>
            <span className="text-roadmap flex items-center gap-1 font-mono">
              <Timer className="h-3 w-3" />
              24:08
            </span>
          </div>
        </div>
      </motion.div>

      {/* Editor */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: [0, -8, 0] }}
        transition={{
          opacity: { duration: 0.8, delay: 0.25 },
          y: { duration: 7, repeat: Infinity, ease: "easeInOut", delay: 1 },
        }}
        className="glass-panel text-panel-foreground absolute bottom-0 right-0 top-0 z-20 flex w-[68%] overflow-hidden rounded-2xl"
      >
        <div className="border-panel-muted/20 flex w-11 shrink-0 flex-col items-center gap-4 border-r py-4">
          <img
            src="/images/pairprep-logo.png"
            alt=""
            className="h-6 w-6 rounded-md object-contain"
          />
          {[FileCode2, Search, Users, MessageCircle, Terminal].map((Icon, i) => (
            <Icon
              key={i}
              className={`h-4 w-4 ${i === 0 ? "text-panel-foreground" : "text-panel-muted"}`}
            />
          ))}
        </div>
        <div className="border-panel-muted/20 hidden w-40 shrink-0 border-r py-3 2xl:block">
          <p className="px-3 pb-2 text-[11px] font-medium">Problems</p>
          {tree.map((t, i) => (
            <motion.p
              key={t.name}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.8 + i * 0.05 }}
              style={{ paddingLeft: 12 + t.depth * 14 }}
              className={`flex items-center gap-1.5 py-1 pr-2 text-[11px] ${
                t.active ? "bg-panel-inner text-panel-foreground" : "text-panel-muted"
              }`}
            >
              {t.folder ? (
                t.open ? (
                  <FolderOpen className="h-3 w-3" />
                ) : (
                  <Folder className="h-3 w-3" />
                )
              ) : (
                <FileCode2 className="h-3 w-3" />
              )}
              <span className="truncate">{t.name}</span>
            </motion.p>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-panel-muted/20 flex items-center gap-5 border-b px-4 py-3 text-[11px]">
            <span className="border-success border-b pb-1">Code</span>
            <span className="text-panel-muted pb-1">Problem</span>
            <span className="text-panel-muted pb-1">Replay</span>
            <span className="border-panel-muted/30 ml-auto flex items-center gap-1 rounded-md border px-2 py-1 text-[10px]">
              <Play className="text-success h-3 w-3" />
              Run
            </span>
          </div>
          <div className="border-panel-muted/20 flex items-center gap-2 border-b px-4 py-2 font-mono text-[10px]">
            <FileCode2 className="text-roadmap h-3 w-3" />
            two_sum.py
            <span className="text-success ml-auto flex items-center gap-1 whitespace-nowrap">
              <span className="bg-success h-1.5 w-1.5 animate-pulse rounded-full" />
              Live
            </span>
          </div>
          <TypedCode />
        </div>
      </motion.div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="currentColor"
        d="M21.35 11.1H12v2.98h5.35c-.23 1.4-1.66 4.1-5.35 4.1-3.22 0-5.85-2.67-5.85-5.96S8.78 6.26 12 6.26c1.83 0 3.06.78 3.76 1.45l2.56-2.47C16.68 3.7 14.55 2.75 12 2.75 6.9 2.75 2.75 6.9 2.75 12S6.9 21.25 12 21.25c5.34 0 8.88-3.75 8.88-9.04 0-.6-.07-1.06-.15-1.51Z"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.85.09-.66.35-1.12.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.04 1.03-2.76-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.64 1.03 2.76 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.1 10.1 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z"
      />
    </svg>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-foreground text-xs font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

const inputClass =
  "h-10 w-full rounded-xl border border-input bg-card/70 px-3.5 text-sm text-foreground shadow-soft outline-none transition placeholder:text-muted-foreground/70 focus:border-ring focus:bg-card focus:ring-4 focus:ring-ring/15";

function AuthForm({ mode }: { mode: AuthMode }) {
  const [showPassword, setShowPassword] = useState(false);
  const [notice, setNotice] = useState(false);
  const signup = mode === "signup";
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setNotice(true);
  };
  const item = (i: number) => ({
    initial: { opacity: 0, y: 14 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.55, delay: 0.35 + i * 0.07, ease },
  });

  return (
    <div className="mx-auto w-full max-w-sm">
      <motion.div
        {...item(0)}
        className="shadow-soft mb-4 inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-card/80"
      >
        <motion.img
          src="/images/pairprep-logo.png"
          alt=""
          className="h-7 w-7 object-contain"
          animate={{ rotate: [0, 8, -8, 0] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        />
      </motion.div>
      <motion.h1
        {...item(1)}
        className="text-foreground text-3xl font-medium tracking-tight"
      >
        {signup ? (
          <>
            Create your <span className="font-serif italic">PairPrep</span> account
          </>
        ) : (
          <>
            Welcome back to <span className="font-serif italic">PairPrep</span>
          </>
        )}
      </motion.h1>
      <motion.p
        {...item(2)}
        className="text-muted-foreground mt-2 text-sm leading-relaxed"
      >
        {signup
          ? "Practice coding problems with a partner and run mock interviews in one shared editor."
          : "Log in to jump back into your practice rooms and mock interviews."}
      </motion.p>

      <form onSubmit={onSubmit} className="mt-5 space-y-3" noValidate>
        {signup && (
          <motion.div {...item(3)}>
            <Field id="username" label="Username">
              <input
                id="username"
                name="username"
                autoComplete="username"
                placeholder="ada_codes"
                className={inputClass}
              />
            </Field>
          </motion.div>
        )}
        <motion.div {...item(4)}>
          <Field id="email" label="Your email">
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="ada@example.com"
              className={inputClass}
            />
          </Field>
        </motion.div>
        <motion.div {...item(5)}>
          <Field id="password" label={signup ? "Create password" : "Password"}>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete={signup ? "new-password" : "current-password"}
                placeholder="••••••••••"
                className={`${inputClass} pr-11`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="text-muted-foreground hover:bg-muted hover:text-foreground absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg transition"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </Field>
        </motion.div>
        <motion.button
          {...item(6)}
          type="submit"
          whileHover={{ y: -2 }}
          whileTap={{ scale: 0.98 }}
          className="bg-primary text-primary-foreground shadow-button group relative mt-1 flex h-10 w-full items-center justify-center gap-2 overflow-hidden rounded-xl text-sm font-medium"
        >
          <span className="auth-button-sheen absolute inset-0" />
          <span className="relative">{signup ? "Create account" : "Log in"}</span>
        </motion.button>
      </form>

      <motion.div
        {...item(7)}
        className="text-muted-foreground my-4 flex items-center gap-3 text-[11px]"
      >
        <span className="bg-border h-px flex-1" />
        or continue with
        <span className="bg-border h-px flex-1" />
      </motion.div>
      <motion.div {...item(8)} className="grid grid-cols-2 gap-3">
        {[
          { label: "Google", Icon: GoogleIcon },
          { label: "GitHub", Icon: GitHubIcon },
        ].map(({ label, Icon }) => (
          <motion.button
            key={label}
            type="button"
            onClick={() => setNotice(true)}
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.97 }}
            className="border-input bg-card/70 text-foreground shadow-soft hover:bg-card flex h-10 items-center justify-center gap-2 rounded-xl border text-sm font-medium transition"
          >
            <Icon />
            {label}
          </motion.button>
        ))}
      </motion.div>

      <AnimatePresence>
        {notice && (
          <motion.p
            role="status"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="border-roadmap/30 bg-roadmap/10 text-foreground mt-4 flex items-start gap-2 overflow-hidden rounded-xl border px-3 py-2.5 text-xs leading-relaxed"
          >
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            PairPrep accounts open with the first practice rooms. Sign-up and log in
            aren't connected yet.
          </motion.p>
        )}
      </AnimatePresence>

      <motion.p {...item(9)} className="text-muted-foreground mt-5 text-center text-sm">
        {signup ? "Already have an account? " : "New to PairPrep? "}
        <Link
          to={signup ? routes.signIn : routes.signUp}
          className="text-foreground decoration-roadmap hover:decoration-foreground font-medium underline decoration-2 underline-offset-4 transition"
        >
          {signup ? "Log in" : "Create an account"}
        </Link>
      </motion.p>
    </div>
  );
}

export function AuthPage({ mode }: { mode: AuthMode }) {
  const reduced = useReducedMotion();

  useEffect(() => {
    document.title =
      mode === "signup" ? "Create your account · PairPrep" : "Log in · PairPrep";
  }, [mode]);

  return (
    <MotionConfig reducedMotion="user">
      <div className="marketing relative min-h-screen overflow-hidden">
        {/* Nature background with slow drift */}
        <motion.img
          src={natureBg}
          alt=""
          width={1920}
          height={1088}
          className="absolute inset-0 h-full w-full object-cover"
          style={{ willChange: "transform", transform: "translateZ(0)" }}
          initial={{ scale: 1.15, opacity: 0 }}
          animate={
            reduced
              ? { scale: 1.05, opacity: 1 }
              : {
                  scale: [1.15, 1.06, 1.12],
                  x: [0, -20, 10],
                  opacity: 1,
                }
          }
          transition={{
            opacity: { duration: 1.2 },
            scale: {
              duration: 40,
              repeat: Infinity,
              repeatType: "mirror",
              ease: "easeInOut",
            },
            x: {
              duration: 40,
              repeat: Infinity,
              repeatType: "mirror",
              ease: "easeInOut",
            },
          }}
        />
        <div className="auth-scrim absolute inset-0" />
        <motion.img
          src="/images/mist-band.webp"
          alt=""
          className="fade-bottom pointer-events-none absolute bottom-0 left-0 h-1/2 w-[140%] max-w-none object-cover opacity-50"
          style={{ willChange: "transform", transform: "translateZ(0)" }}
          animate={reduced ? { x: "0%" } : { x: ["0%", "-25%", "0%"] }}
          transition={{ duration: 60, repeat: Infinity, ease: "linear" }}
        />
        <div className="auth-sheen pointer-events-none absolute inset-0" />
        {Array.from({ length: 8 }).map((_, i) => (
          <motion.span
            key={i}
            className="auth-particle pointer-events-none absolute rounded-full"
            style={{
              left: `${(i * 47) % 100}%`,
              bottom: -10,
              width: 3 + (i % 3) * 2,
              height: 3 + (i % 3) * 2,
            }}
            animate={reduced ? { opacity: 0 } : { y: [0, -900], opacity: [0, 0.9, 0] }}
            transition={{
              duration: 14 + (i % 4) * 3,
              repeat: Infinity,
              delay: i * 1.8,
              ease: "linear",
            }}
          />
        ))}

        <header className="text-panel-foreground relative z-10 mx-auto flex max-w-7xl items-center justify-between px-5 pt-4 md:px-10">
          <Link to="/" aria-label="PairPrep home">
            <Logo />
          </Link>
          <Link
            to="/"
            className="glass-inner flex items-center gap-1.5 rounded-full px-3 py-2 text-sm transition hover:-translate-y-0.5"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to site
          </Link>
        </header>

        <main className="relative z-10 mx-auto flex max-w-7xl items-center px-4 pb-6 pt-4 md:px-10 lg:min-h-[calc(100vh-72px)]">
          <motion.div
            initial={{ opacity: 0, y: 40, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.8, ease }}
            className="auth-shell grid w-full gap-6 rounded-[2rem] p-3 lg:grid-cols-[1.6fr_1fr] lg:p-3"
          >
            <div className="relative hidden overflow-hidden rounded-[1.6rem] p-6 lg:block">
              <img
                src={natureBg}
                alt=""
                className="absolute inset-0 h-full w-full scale-125 object-cover opacity-70"
              />
              <div className="auth-scrim absolute inset-0" />
              <div className="relative h-full">
                <CodingScreen />
              </div>
            </div>
            <div className="auth-form-panel flex items-center rounded-[1.6rem] px-6 py-8 sm:px-8 lg:py-6">
              <AnimatePresence mode="wait">
                <motion.div
                  key={mode}
                  className="w-full"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.35, ease }}
                >
                  <AuthForm mode={mode} />
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        </main>
      </div>
    </MotionConfig>
  );
}
