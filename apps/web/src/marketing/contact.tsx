import { useEffect } from "react";
import { MarketingPage } from "./page.js";

export default function ContactPage() {
  useEffect(() => {
    document.title = "Contact · PairPrep";
  }, []);

  return (
    <MarketingPage title="Contact">
      <p className="text-muted-foreground mt-6">
        Contact address: placeholder — no contact address has been supplied.
      </p>
    </MarketingPage>
  );
}
