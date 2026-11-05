import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Navigate } from "react-router-dom";
import LoginPage from "../login.js";
import LandingPage from "../landing.js";
import InterviewPage from "../interview.js";
import PrivacyPage from "../privacy.js";
import TermsPage from "../terms.js";
import ContactPage from "../contact.js";
import { features } from "../../config/features.js";
import { routes } from "../../config/routes.js";

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
  });

  it("sanitizes returnTo parameter to prevent open redirects", () => {
    // Malicious absolute URL
    const { unmount: u1 } = render(
      <MemoryRouter initialEntries={["/login?returnTo=https://evil.com/phish"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    );
    const googleLinkEvil = screen.getByRole("link", { name: /Continue with Google/i });
    expect(googleLinkEvil).toHaveAttribute("href", "/api/v1/auth/google");
    u1();

    // Protocol-relative URL
    const { unmount: u2 } = render(
      <MemoryRouter initialEntries={["/login?returnTo=//evil.com"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    );
    const googleLinkProto = screen.getByRole("link", { name: /Continue with Google/i });
    expect(googleLinkProto).toHaveAttribute("href", "/api/v1/auth/google");
    u2();

    // Valid internal path
    const { unmount: u3 } = render(
      <MemoryRouter initialEntries={["/login?returnTo=/r/my-room"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    );
    const googleLinkValid = screen.getByRole("link", { name: /Continue with Google/i });
    expect(googleLinkValid).toHaveAttribute(
      "href",
      "/api/v1/auth/google?returnTo=%2Fr%2Fmy-room"
    );
    u3();
  });

  it("handles OAuth ?error= query parameter with allowlisted user messages", () => {
    const errorCases = [
      { code: "access_denied", text: /access denied/i },
      { code: "missing_state", text: /invalid session state/i },
      { code: "missing_code", text: /authorization code missing/i },
      { code: "auth_failed", text: /authentication failed/i },
      { code: "provider_unavailable", text: /temporarily unavailable/i },
      { code: "unknown_injected_error", text: /unable to sign in/i },
    ];

    for (const ec of errorCases) {
      const { unmount } = render(
        <MemoryRouter initialEntries={[`/login?error=${ec.code}`]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </MemoryRouter>
      );
      const alert = screen.getByRole("alert");
      expect(alert).toBeInTheDocument();
      expect(alert).toHaveTextContent(ec.text);
      unmount();
    }
  });

  it("/signup redirects to /login (use /login only)", () => {
    render(
      <MemoryRouter initialEntries={["/signup"]}>
        <Routes>
          <Route path="/signup" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText(/Welcome back to/i)).toBeInTheDocument();
    expect(screen.queryByText(/Create your account/i)).toBeNull();
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

  it("privacy and terms match what we store, and contact has no dead form", () => {
    const { unmount: u1 } = render(
      <MemoryRouter initialEntries={["/privacy"]}>
        <Routes>
          <Route path="/privacy" element={<PrivacyPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(
      screen.getByRole("heading", { name: /^Privacy Policy$/i })
    ).toBeInTheDocument();
    expect(screen.getAllByText(/pairprep\.sid/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/pairprep\.guest/i).length).toBeGreaterThan(0);
    // Cookies listed with lifetimes
    expect(screen.getByText(/7-day rolling inactivity lifetime/i)).toBeInTheDocument();
    expect(screen.getByText(/7-day lifetime/i)).toBeInTheDocument();
    // OAuth data stored: name, email if provided, avatar
    expect(screen.getByText(/name, email if provided, avatar/i)).toBeInTheDocument();
    // Rooms (not accounts) are archived after 30 days of inactivity
    expect(
      screen.getByText(/Rooms \(not accounts\) are archived after 30 days of inactivity/i)
    ).toBeInTheDocument();
    // Room content stored in database until room is deleted
    expect(
      screen.getByText(
        /Room content \(code and chat\) is stored in the database until the room is deleted/i
      )
    ).toBeInTheDocument();
    // Code and chat are never written to server logs
    expect(
      screen.getByText(/code and chat are never written to server logs/i)
    ).toBeInTheDocument();
    // No self-service deletion: users request deletion via /contact
    expect(
      screen.getByText(/There is no self-service deletion: users request deletion via/i)
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /\/contact/i })).toBeInTheDocument();
    u1();

    const { unmount: u2 } = render(
      <MemoryRouter initialEntries={["/terms"]}>
        <Routes>
          <Route path="/terms" element={<TermsPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(
      screen.getByRole("heading", { name: /^Terms of Service$/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/isolated, disposable containers/i)).toBeInTheDocument();
    expect(screen.getAllByText(/pairprep\.sid/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/pairprep\.guest/i).length).toBeGreaterThan(0);
    // OAuth data stored: name, email if provided, avatar
    expect(screen.getByText(/name, email if provided, avatar/i)).toBeInTheDocument();
    // Cookies with lifetimes
    expect(screen.getByText(/7-day rolling inactivity lifetime/i)).toBeInTheDocument();
    // Rooms (not accounts) archived after 30 days of inactivity
    expect(
      screen.getByText(/Rooms \(not accounts\) are archived after 30 days of inactivity/i)
    ).toBeInTheDocument();
    // Room content stored in DB until deleted
    expect(
      screen.getByText(
        /Room content \(code and chat\) is stored in the database until the room is deleted/i
      )
    ).toBeInTheDocument();
    // Code and chat never written to server logs
    expect(
      screen.getByText(/Code and chat are never written to server logs/i)
    ).toBeInTheDocument();
    // No self-service deletion: users request deletion via /contact
    expect(
      screen.getByText(/There is no self-service deletion: users request deletion via/i)
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /\/contact/i })).toBeInTheDocument();
    u2();

    const { unmount: u3, container: contactContainer } = render(
      <MemoryRouter initialEntries={["/contact"]}>
        <Routes>
          <Route path="/contact" element={<ContactPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByRole("heading", { name: /^Contact$/i })).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: /github\.com\/Shubhx8\/pairprep-starter\/issues/i,
      })
    ).toBeInTheDocument();
    // Zero dead form submissions
    expect(contactContainer.querySelectorAll("form").length).toBe(0);
    expect(contactContainer.querySelectorAll("input").length).toBe(0);
    u3();
  });

  it("routes.ts configuration: Start a room -> /dashboard, Sign in -> /login, no /rooms/new", () => {
    expect(routes.start).toBe("/dashboard");
    expect(routes.signIn).toBe("/login");
    expect(routes.signUp).toBe("/login");
    expect((routes as Record<string, string>)["roomsNew"]).toBeUndefined();
    expect(Object.values(routes)).not.toContain("/rooms/new");
  });

  it("landing page and login page contain no email or password input fields", () => {
    const { container: loginContainer, unmount: uLogin } = render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(loginContainer.querySelector('input[type="password"]')).toBeNull();
    expect(loginContainer.querySelector('input[type="email"]')).toBeNull();
    expect(loginContainer.querySelectorAll("input").length).toBe(0);
    uLogin();

    const { container: landingContainer, unmount: uLanding } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(landingContainer.querySelector('input[type="password"]')).toBeNull();
    expect(landingContainer.querySelector('input[type="email"]')).toBeNull();
    expect(landingContainer.querySelectorAll('input[type="password"]').length).toBe(0);
    expect(landingContainer.querySelectorAll('input[type="email"]').length).toBe(0);
    uLanding();
  });
});
