import { useEffect } from "react";
import { MarketingPage } from "./page.js";

export default function ContactPage() {
  useEffect(() => {
    document.title = "Contact · PairPrep";
  }, []);

  return (
    <MarketingPage title="Contact">
      <div className="mt-8 max-w-2xl space-y-4 text-base leading-relaxed text-muted-foreground">
        <p>
          For bug reports, technical inquiries, or feature suggestions, please reach out
          via our GitHub repository issues:
        </p>
        <p>
          <a
            href="https://github.com/Shubhx8/pairprep-starter/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline underline-offset-4 font-medium"
          >
            github.com/Shubhx8/pairprep-starter/issues
          </a>
        </p>
        <p className="text-sm">
          No third-party contact forms or untracked submission scripts are used on this
          page.
        </p>
      </div>
    </MarketingPage>
  );
}
