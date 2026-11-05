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
            When you sign in via Google or GitHub OAuth 2.0, our OAuth data stored is
            strictly limited to: name, email if provided, avatar. We never collect, store,
            or prompt for passwords.
          </p>
        </div>

        <div>
          <h2 className="text-foreground font-medium text-lg">
            2. Cookie Usage: pairprep.sid & pairprep.guest
          </h2>
          <p className="mt-2">
            PairPrep uses two essential first-party, httpOnly, secure cookies strictly for
            session management and authentication, listed with lifetimes below:
          </p>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li>
              <code className="text-foreground font-mono text-xs">pairprep.sid</code>:
              Maintains authenticated session state for signed-in users with a 7-day
              rolling inactivity lifetime.
            </li>
            <li>
              <code className="text-foreground font-mono text-xs">pairprep.guest</code>:
              Maintains temporary in-room participant state for guest users with a 7-day
              lifetime (or replaced when joining another room, as active guest sessions
              are limited to one room at a time).
            </li>
          </ul>
          <p className="mt-2">
            We use zero advertising trackers, analytics beacons, or third-party marketing
            cookies.
          </p>
        </div>

        <div>
          <h2 className="text-foreground font-medium text-lg">
            3. Code and Chat Privacy & Logging Standards
          </h2>
          <p className="mt-2">
            Room content (code and chat) is stored in the database until the room is
            deleted. User code and chat are never written to server logs or operational
            telemetry. Structured application logs strictly record request metadata (HTTP
            status, response latency, and request IDs) for system health and security
            defense.
          </p>
        </div>

        <div>
          <h2 className="text-foreground font-medium text-lg">
            4. Inactivity Archiving & Retention
          </h2>
          <p className="mt-2">
            Rooms (not accounts) are archived after 30 days of inactivity to safeguard
            storage and prevent resource exhaustion. User accounts remain intact.
          </p>
        </div>

        <div>
          <h2 className="text-foreground font-medium text-lg">
            5. Deletion Request Path & Contact
          </h2>
          <p className="mt-2">
            There is no self-service deletion: users request deletion via{" "}
            <Link
              to="/contact"
              className="text-primary font-medium underline underline-offset-4 hover:text-primary/80"
            >
              /contact
            </Link>
            . We process all verified deletion requests for personal profiles and room
            records promptly upon receipt.
          </p>
        </div>
      </div>
    </MarketingPage>
  );
}
