import { useEffect } from "react";
import { Link, Navigate } from "react-router-dom";
import { MarketingPage } from "./page.js";
import { InterviewWorkflow, FeedbackShowcase } from "./product-sections.js";
import { features } from "../config/features.js";
import { routes } from "../config/routes.js";
import { Button } from "./button.js";

export default function InterviewPage() {
  useEffect(() => {
    document.title = "Mock interviews · PairPrep";
  }, []);

  if (!features.interviewMode) {
    return <Navigate to="/" replace />;
  }

  return (
    <MarketingPage title="Mock interviews, together.">
      <InterviewWorkflow />
      <FeedbackShowcase />
      <p className="text-muted-foreground text-center text-sm">
        Interface previews are illustrative.
      </p>
      <div className="mt-8 text-center">
        <Button asChild>
          <Link to={routes.start}>Set up a mock interview</Link>
        </Button>
      </div>
    </MarketingPage>
  );
}
