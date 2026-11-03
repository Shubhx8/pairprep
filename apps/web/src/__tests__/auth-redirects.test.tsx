import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { RootRoute, ProtectedRoute } from "../App.js";
import * as authContextModule from "../lib/authContext.js";

vi.mock("../marketing/landing.js", () => ({
  default: () => <div data-testid="landing-page">Mock Landing Page</div>,
}));

vi.mock("../pages/DashboardPage.js", () => ({
  default: () => <div data-testid="dashboard-page">Mock Dashboard Page</div>,
}));

vi.mock("../marketing/login.js", () => ({
  default: () => <div data-testid="login-page">Mock Login Page</div>,
}));

describe("Authentication Route Redirects (Requirement 4)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("'/' redirects signed-in users to /dashboard", async () => {
    vi.spyOn(authContextModule, "useAuth").mockReturnValue({
      user: {
        id: "usr_123",
        email: "alice@example.com",
        displayName: "Alice",
        avatarUrl: undefined,
        provider: "google",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
      },
      status: "authenticated",
      isLoading: false,
      isAuthenticated: true,
      login: vi.fn(),
      logout: vi.fn(),
      refreshMe: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<RootRoute />} />
          <Route
            path="/dashboard"
            element={<div data-testid="dashboard-page">Dashboard</div>}
          />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId("dashboard-page")).toBeInTheDocument();
    expect(screen.queryByTestId("landing-page")).toBeNull();
  });

  it("'/' renders landing page for anonymous users", async () => {
    vi.spyOn(authContextModule, "useAuth").mockReturnValue({
      user: null,
      status: "anonymous",
      isLoading: false,
      isAuthenticated: false,
      login: vi.fn(),
      logout: vi.fn(),
      refreshMe: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<RootRoute />} />
          <Route
            path="/dashboard"
            element={<div data-testid="dashboard-page">Dashboard</div>}
          />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByTestId("landing-page")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-page")).toBeNull();
  });

  it("/dashboard redirects anonymous users to /login", async () => {
    vi.spyOn(authContextModule, "useAuth").mockReturnValue({
      user: null,
      status: "anonymous",
      isLoading: false,
      isAuthenticated: false,
      login: vi.fn(),
      logout: vi.fn(),
      refreshMe: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <div data-testid="dashboard-content">Dashboard Protected Content</div>
              </ProtectedRoute>
            }
          />
          <Route path="/login" element={<div data-testid="login-page">Login Page</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId("login-page")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-content")).toBeNull();
  });

  it("/dashboard allows signed-in users to access protected content", async () => {
    vi.spyOn(authContextModule, "useAuth").mockReturnValue({
      user: {
        id: "usr_456",
        email: "bob@example.com",
        displayName: "Bob",
        avatarUrl: undefined,
        provider: "github",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
      },
      status: "authenticated",
      isLoading: false,
      isAuthenticated: true,
      login: vi.fn(),
      logout: vi.fn(),
      refreshMe: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <div data-testid="dashboard-content">Dashboard Protected Content</div>
              </ProtectedRoute>
            }
          />
          <Route path="/login" element={<div data-testid="login-page">Login Page</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId("dashboard-content")).toBeInTheDocument();
    expect(screen.queryByTestId("login-page")).toBeNull();
  });
});
