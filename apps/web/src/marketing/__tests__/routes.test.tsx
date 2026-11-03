import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import LoginPage from "../login.js";
import SignupPage from "../signup.js";
import InterviewPage from "../interview.js";
import DashboardPage from "../dashboard.js";
import PrivacyPage from "../privacy.js";
import TermsPage from "../terms.js";
import ContactPage from "../contact.js";
import { features } from "../../config/features.js";

describe("Marketing Route Rendering", () => {
  it("renders /login with OAuth links only and no password or email fields", () => {
    render(
      <MemoryRouter initialEntries={["/login?returnTo=/dashboard"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText(/Welcome back to/i)).toBeInTheDocument();
    const googleLink = screen.getByRole("link", { name: /Continue with Google/i });
    const githubLink = screen.getByRole("link", { name: /Continue with GitHub/i });
    expect(googleLink).toBeInTheDocument();
    expect(googleLink).toHaveAttribute(
      "href",
      "/api/v1/auth/google?returnTo=%2Fdashboard"
    );
    expect(githubLink).toBeInTheDocument();
    expect(githubLink).toHaveAttribute(
      "href",
      "/api/v1/auth/github?returnTo=%2Fdashboard"
    );
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByLabelText(/email/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Log in$/i })).toBeNull();
    expect(screen.getByText(/Practicing/i)).toBeInTheDocument();
  });

  it("renders /signup with OAuth links only and no password, email, or username fields", () => {
    render(
      <MemoryRouter initialEntries={["/signup"]}>
        <Routes>
          <Route path="/signup" element={<SignupPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText(/Create your/i)).toBeInTheDocument();
    const googleLink = screen.getByRole("link", { name: /Continue with Google/i });
    const githubLink = screen.getByRole("link", { name: /Continue with GitHub/i });
    expect(googleLink).toBeInTheDocument();
    expect(googleLink).toHaveAttribute("href", "/api/v1/auth/google");
    expect(githubLink).toBeInTheDocument();
    expect(githubLink).toHaveAttribute("href", "/api/v1/auth/github");
    expect(screen.queryByLabelText(/username/i)).toBeNull();
    expect(screen.queryByLabelText(/email/i)).toBeNull();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Create account$/i })).toBeNull();
  });

  it("renders /interview when interviewMode flag is enabled", () => {
    features.interviewMode = true;
    render(
      <MemoryRouter initialEntries={["/interview"]}>
        <Routes>
          <Route path="/interview" element={<InterviewPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText(/Mock interviews, together\./i)).toBeInTheDocument();
    expect(screen.getByText(/Experience a technical interview,/i)).toBeInTheDocument();
    expect(screen.getAllByText(/SESSION REPLAY/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/INTERVIEW SCORECARD/i).length).toBeGreaterThan(0);
  });

  it("renders /dashboard, /privacy, /terms, and /contact", () => {
    const { unmount: u1 } = render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText(/Your practice dashboard/i)).toBeInTheDocument();
    u1();

    const { unmount: u2 } = render(
      <MemoryRouter initialEntries={["/privacy"]}>
        <Routes>
          <Route path="/privacy" element={<PrivacyPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByRole("heading", { name: /^Privacy$/i })).toBeInTheDocument();
    u2();

    const { unmount: u3 } = render(
      <MemoryRouter initialEntries={["/terms"]}>
        <Routes>
          <Route path="/terms" element={<TermsPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByRole("heading", { name: /^Terms$/i })).toBeInTheDocument();
    u3();

    const { unmount: u4 } = render(
      <MemoryRouter initialEntries={["/contact"]}>
        <Routes>
          <Route path="/contact" element={<ContactPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByRole("heading", { name: /^Contact$/i })).toBeInTheDocument();
    u4();
  });
});
