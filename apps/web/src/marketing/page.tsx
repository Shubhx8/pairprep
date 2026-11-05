import { type ReactNode } from "react";
import { MotionConfig } from "framer-motion";
import { Nav, Footer } from "./landing.js";

export function MarketingPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <MotionConfig reducedMotion="user">
      <div className="marketing">
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <Nav />
        <main
          id="main-content"
          className="mx-auto min-h-[60vh] max-w-[88rem] px-5 pb-20 pt-40 md:px-10"
        >
          <h1 className="text-4xl font-medium md:text-5xl">{title}</h1>
          {children}
        </main>
        <Footer />
      </div>
    </MotionConfig>
  );
}
