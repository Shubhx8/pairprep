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
