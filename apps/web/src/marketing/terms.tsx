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
            Authentication is passwordless via Google and GitHub OAuth 2.0. Our OAuth data
            stored is strictly limited to: name, email if provided, avatar. Session state
            is maintained via two first-party cookies with defined lifetimes:
          </p>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li>
              <code className="text-foreground font-mono text-xs">pairprep.sid</code>:
              Maintains authenticated user sessions with a 7-day rolling inactivity
              lifetime.
            </li>
            <li>
              <code className="text-foreground font-mono text-xs">pairprep.guest</code>:
              Maintains temporary guest access with a 7-day lifetime (or until joining
              another room).
            </li>
          </ul>
        </div>

        <div>
          <h2 className="text-foreground font-medium text-lg">
            3. Privacy, Persistence & Logging Standards
          </h2>
          <p className="mt-2">
            Room content (code and chat) is stored in the database until the room is
            deleted. Code and chat are never written to server logs. Rooms (not accounts)
            are archived after 30 days of inactivity.
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
            There is no self-service deletion: users request deletion via{" "}
            <Link
              to="/contact"
              className="text-primary font-medium underline underline-offset-4 hover:text-primary/80"
            >
              /contact
            </Link>
            . We process all verified deletion requests promptly upon receipt.
          </p>
        </div>
      </div>
    </MarketingPage>
  );
}
