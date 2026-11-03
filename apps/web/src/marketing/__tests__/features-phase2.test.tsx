import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import LandingPage from "../landing.js";
import { features } from "../../config/features.js";

describe("Landing Page Feature Gating (Requirement 8)", () => {
  beforeEach(() => {
    // Reset to default false
    features.interviewMode = false;
    features.sessionReplay = false;
    features.scorecard = false;
    features.showRoadmap = false;
  });

  it("removes invented numbers or statistics such as '66 Partners'", () => {
    render(
      <BrowserRouter>
        <LandingPage />
      </BrowserRouter>
    );

    expect(screen.queryByText(/66 Partners/i)).toBeNull();
  });

  it("default: zero occurrences of 'Phase', 'Roadmap', 'upcoming', and 'coming soon' on landing page", () => {
    const { container } = render(
      <BrowserRouter>
        <LandingPage />
      </BrowserRouter>
    );

    const text = container.textContent || "";
    expect(text).not.toMatch(/Phase/i);
    expect(text).not.toMatch(/Roadmap/i);
    expect(text).not.toMatch(/upcoming/i);
    expect(text).not.toMatch(/coming soon/i);
  });

  it("flags on: renders roadmap text when showRoadmap flag is explicitly turned on", () => {
    features.showRoadmap = true;

    render(
      <BrowserRouter>
        <LandingPage />
      </BrowserRouter>
    );

    expect(screen.getAllByText(/Phase 2 Roadmap/i).length).toBeGreaterThan(0);
  });

  it("default: flagged Phase 2 sections are completely absent when all flags are off", () => {
    render(
      <BrowserRouter>
        <LandingPage />
      </BrowserRouter>
    );

    // InterviewTeaser should be absent
    expect(screen.queryByText(/See how mock interviews work/i)).toBeNull();

    // Core practice mode must still be present
    expect(screen.getByText(/PRACTICE MODE/i)).toBeInTheDocument();
    expect(screen.getByText(/Learn by building together/i)).toBeInTheDocument();
  });

  it("flags on: renders active features when flags are on", () => {
    features.interviewMode = true;
    features.sessionReplay = true;
    features.scorecard = true;

    render(
      <BrowserRouter>
        <LandingPage />
      </BrowserRouter>
    );

    // Flagged sections must now be present
    expect(screen.getByText(/See how mock interviews work/i)).toBeInTheDocument();
    expect(screen.getByText(/PRACTICE MODE/i)).toBeInTheDocument();
  });
});
