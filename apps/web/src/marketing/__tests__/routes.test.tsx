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

describe("Marketing Route Rendering", () => {
  it("renders /login with sign in heading and oauth buttons", () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText(/Welcome back to/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Log in$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /GitHub/i })).toBeInTheDocument();
    expect(screen.getByText(/Practicing/i)).toBeInTheDocument();
  });

  it("renders /signup with username field and create account button", () => {
    render(
      <MemoryRouter initialEntries={["/signup"]}>
        <Routes>
          <Route path="/signup" element={<SignupPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText(/Create your/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Username/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Create account$/i })).toBeInTheDocument();
  });

  it("renders /interview with 5 workflow steps and feedback previews", () => {
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
