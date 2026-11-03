import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./lib/authContext.js";

const LandingPage = lazy(() => import("./marketing/landing.js"));
const LoginPage = lazy(() => import("./marketing/login.js"));
const SignupPage = lazy(() => import("./marketing/signup.js"));
const InterviewPage = lazy(() => import("./marketing/interview.js"));
const DashboardPage = lazy(() => import("./pages/DashboardPage.js"));
const PrivacyPage = lazy(() => import("./marketing/privacy.js"));
const TermsPage = lazy(() => import("./marketing/terms.js"));
const ContactPage = lazy(() => import("./marketing/contact.js"));

const LazyToaster = lazy(() =>
  import("./components/ui/Toast.js").then((m) => ({ default: m.Toaster }))
);

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={null}>
          <LazyToaster />
        </Suspense>

        <Suspense
          fallback={
            <div className="bg-canvas text-text-secondary flex min-h-screen items-center justify-center font-mono text-sm">
              Loading PairPrep...
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/interview" element={<InterviewPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/contact" element={<ContactPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  );
}
