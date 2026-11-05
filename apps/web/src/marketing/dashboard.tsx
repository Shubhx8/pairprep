import { useEffect } from "react";
import { Link } from "react-router-dom";
import { MarketingPage } from "./page.js";
import { Button } from "./button.js";

export default function DashboardPage() {
  useEffect(() => {
    document.title = "Dashboard · PairPrep";
  }, []);

  return (
    <MarketingPage title="Your practice dashboard">
      <p className="text-muted-foreground mt-6">
        Live rooms and account management are not connected to this presentation site.
      </p>
      <Button asChild className="mt-8">
        <Link to="/">Back to PairPrep</Link>
      </Button>
    </MarketingPage>
  );
}
