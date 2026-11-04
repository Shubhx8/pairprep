import { useEffect } from "react";
import { Link } from "react-router-dom";
import { MarketingPage } from "./page.js";

export default function TermsPage() {
  useEffect(() => {
    document.title = "Terms of Service · PairPrep";
  }, []);

  return (
    <MarketingPage title="Terms of Service">
      <div className="mt-8 max-w-2xl space-y-6 text-base leading-relaxed text-muted-foreground">
        <div>
          <h2 className="text-foreground font-medium text-lg">1. Service Purpose</h2>
          <p className="mt-2">
            PairPrep is an educational collaborative platform designed for technical
            interview preparation, peer pair programming, and coding practice.
          </p>
        </div>

        <div>
          <h2 className="text-foreground font-medium text-lg">
            2. Authentication & Account Data
          </h2>
          <p className="mt-2">
            Authentication is passwordless via Google and GitHub OAuth 2.0. We store only
            your provider display name, email address, and avatar image. Session state is
            maintained securely via the httpOnly{" "}
            <code className="text-foreground font-mono text-xs">pairprep.sid</code> cookie
            for authenticated users and{" "}
            <code className="text-foreground font-mono text-xs">pairprep.guest</code>{" "}
            cookie for temporary room guests.
          </p>
        </div>

        <div>
          <h2 className="text-foreground font-medium text-lg">
            3. Privacy & Logging Standards
          </h2>
          <p className="mt-2">
            Your intellectual property and interview content remain private. User code and
            in-room chat messages are{" "}
            <strong className="text-foreground">never recorded in server logs</strong>.
            Rooms and associated session documents are automatically archived after{" "}
            <strong className="text-foreground">30 days of inactivity</strong>.
          </p>
        </div>

        <div>
          <h2 className="text-foreground font-medium text-lg">
            4. Acceptable Use & Sandboxing
          </h2>
          <p className="mt-2">
            Code execution runs inside isolated, disposable containers with strict CPU,
            memory, time, and network constraints. You agree not to attempt to compromise
            the sandbox, probe internal infrastructure, or disrupt sessions.
          </p>
        </div>

        <div>
          <h2 className="text-foreground font-medium text-lg">
            5. Account Deletion & Inquiries
          </h2>
          <p className="mt-2">
            You may terminate your account or submit a deletion request for all personal
            and room data at any time via our{" "}
            <Link
              to="/contact"
              className="text-primary font-medium underline underline-offset-4 hover:text-primary/80"
            >
              Contact page
            </Link>
            . We process all verified deletion requests promptly.
          </p>
        </div>
      </div>
    </MarketingPage>
  );
}
