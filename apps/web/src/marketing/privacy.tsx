import { useEffect } from "react";
import { Link } from "react-router-dom";
import { MarketingPage } from "./page.js";

export default function PrivacyPage() {
  useEffect(() => {
    document.title = "Privacy Policy · PairPrep";
  }, []);

  return (
    <MarketingPage title="Privacy Policy">
      <div className="mt-8 max-w-2xl space-y-6 text-base leading-relaxed text-muted-foreground">
        <div>
          <h2 className="text-foreground font-medium text-lg">
            1. Information We Collect & OAuth Data
          </h2>
          <p className="mt-2">
            When you sign in via Google or GitHub OAuth 2.0, we collect and store only
            your verified provider profile details: your display name, email address,
            avatar image URL, and unique provider account identifier. We never collect,
            store, or prompt for passwords.
          </p>
        </div>

        <div>
          <h2 className="text-foreground font-medium text-lg">
            2. Cookie Usage: pairprep.sid & pairprep.guest
          </h2>
          <p className="mt-2">
            PairPrep uses two essential first-party, httpOnly, secure cookies strictly for
            session management and authentication:
          </p>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li>
              <code className="text-foreground font-mono text-xs">pairprep.sid</code>:
              Maintains authenticated session state for signed-in users (7-day rolling
              inactivity timeout).
            </li>
            <li>
              <code className="text-foreground font-mono text-xs">pairprep.guest</code>:
              Maintains temporary in-room participant state for guest users (scoped to a
              single active room).
            </li>
          </ul>
          <p className="mt-2">
            We use zero advertising trackers, analytics beacons, or third-party marketing
            cookies.
          </p>
        </div>

        <div>
          <h2 className="text-foreground font-medium text-lg">
            3. Code and Chat Privacy: Never Logged
          </h2>
          <p className="mt-2">
            Your collaborative work is confidential. User-submitted source code, CRDT
            binary updates (Yjs), and real-time room chat messages are{" "}
            <strong className="text-foreground">never recorded in server logs</strong> or
            operational telemetry. Structured application logs strictly capture HTTP
            metadata (status codes, response latency, and request IDs) for system health
            and security defense.
          </p>
        </div>

        <div>
          <h2 className="text-foreground font-medium text-lg">
            4. Inactivity Archiving & Retention
          </h2>
          <p className="mt-2">
            Practice rooms and associated session documents are automatically archived
            after <strong className="text-foreground">30 days of inactivity</strong> to
            safeguard storage and system efficiency.
          </p>
        </div>

        <div>
          <h2 className="text-foreground font-medium text-lg">
            5. Deletion Request Path & Contact
          </h2>
          <p className="mt-2">
            You retain complete control over your personal data. You may delete rooms
            directly from your dashboard or request complete deletion of your account,
            OAuth profile data, and practice sessions at any time through our{" "}
            <Link
              to="/contact"
              className="text-primary font-medium underline underline-offset-4 hover:text-primary/80"
            >
              Contact & Support page
            </Link>{" "}
            or by submitting a data deletion request.
          </p>
        </div>
      </div>
    </MarketingPage>
  );
}
