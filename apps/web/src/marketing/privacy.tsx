import { useEffect } from "react";
import { MarketingPage } from "./page.js";
import { LegalContent } from "./legal.js";

export default function PrivacyPage() {
  useEffect(() => {
    document.title = "Privacy · PairPrep";
  }, []);

  return (
    <MarketingPage title="Privacy">
      <LegalContent />
    </MarketingPage>
  );
}
