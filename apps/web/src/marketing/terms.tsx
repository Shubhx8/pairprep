import { useEffect } from "react";
import { MarketingPage } from "./page.js";
import { LegalContent } from "./legal.js";

export default function TermsPage() {
  useEffect(() => {
    document.title = "Terms · PairPrep";
  }, []);

  return (
    <MarketingPage title="Terms">
      <LegalContent />
    </MarketingPage>
  );
}
