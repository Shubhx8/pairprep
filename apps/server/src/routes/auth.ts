import { Router, Request, Response, NextFunction } from "express";
import { passport } from "../auth/passport.js";
import { config } from "../config.js";
import { SESSION_COOKIE_NAME } from "../middleware/session.js";
import { rootLogger } from "../middleware/logger.js";
import { IUser } from "../models/users.js";

export const authRouter = Router();

// PRD 6.1: Apply Cache-Control: no-store to all auth endpoints
authRouter.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  next();
});

/**
 * Validates returnTo path to prevent open redirect vulnerabilities.
 * Must begin with a single '/' and not '//' (avoid protocol-relative redirects).
 */
export function sanitizeReturnTo(raw?: string): string {
  if (!raw) return "/";
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) {
    return raw;
  }
  return "/";
}

/**
 * GET /api/v1/auth/google
 * Initiates Google OAuth 2.0 flow with PKCE and state managed by passport-oauth2
 */
authRouter.get("/google", (req: Request, res: Response, next: NextFunction) => {
  if (req.query["returnTo"] && typeof req.query["returnTo"] === "string") {
    req.session.returnTo = sanitizeReturnTo(req.query["returnTo"]);
  }

  passport.authenticate("google", {
    scope: ["profile", "email"],
  })(req, res, next);
});

/**
 * GET /api/v1/auth/github
 * Initiates GitHub OAuth 2.0 flow with state managed by passport-oauth2
 */
authRouter.get("/github", (req: Request, res: Response, next: NextFunction) => {
  if (req.query["returnTo"] && typeof req.query["returnTo"] === "string") {
    req.session.returnTo = sanitizeReturnTo(req.query["returnTo"]);
  }

  passport.authenticate("github", {
    scope: ["user:email"],
  })(req, res, next);
});

export type OAuthErrorCode =
  "access_denied" | "auth_failed" | "missing_state" | "missing_code";

const handleOAuthCallback = (
  provider: "google" | "github",
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Map errors strictly to allowlist: access_denied, auth_failed, missing_state, missing_code
  // Never interpolate raw req.query.error or err.code into redirect URL
  if (req.query["error"] === "access_denied") {
    return res.redirect("/login?error=access_denied");
  }
  if (req.query["error"]) {
    return res.redirect("/login?error=auth_failed");
  }
  if (!req.query["state"] || typeof req.query["state"] !== "string") {
    return res.redirect("/login?error=missing_state");
  }
  if (!req.query["code"] || typeof req.query["code"] !== "string") {
    return res.redirect("/login?error=missing_code");
  }

  passport.authenticate(
    provider,
    (err: Error | null, user: IUser | false, info: unknown) => {
      if (err || !user) {
        rootLogger.warn(
          { err: err?.message, info, provider },
          `${provider} authentication callback failed`
        );
        return res.redirect("/login?error=auth_failed");
      }

      const returnTo = sanitizeReturnTo(req.session.returnTo);
      delete req.session.returnTo;

      // Session Fixation Prevention
      req.session.regenerate((regenErr) => {
        if (regenErr) {
          rootLogger.error({ err: regenErr }, "Session regeneration failed at login");
          return next(regenErr);
        }

        req.login(user, (loginErr) => {
          if (loginErr) {
            rootLogger.error({ err: loginErr }, "Passport session login failed");
            return next(loginErr);
          }

          req.session.save((saveErr) => {
            if (saveErr) {
              rootLogger.error({ err: saveErr }, "Session save failed at login");
              return next(saveErr);
            }

            res.redirect(returnTo);
          });
        });
      });
    }
  )(req, res, next);
};

/**
 * PRD 13.1: GET /api/v1/auth/callback/:provider
 * Allowlist: google | github, else 404
 */
authRouter.get(
  "/callback/:provider",
  (req: Request, res: Response, next: NextFunction) => {
    const rawProvider = req.params["provider"];
    const provider =
      typeof rawProvider === "string" ? rawProvider.trim().toLowerCase() : "";

    if (provider === "google" || provider === "github") {
      return handleOAuthCallback(provider, req, res, next);
    }

    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
        requestId:
          (res.getHeader("X-Request-Id") as string) ||
          (req as unknown as { id?: string }).id ||
          "",
      },
    });
  }
);

/**
 * POST /api/v1/auth/logout
 * Destroys session in MongoDB session store and clears the pairprep.sid cookie.
 * Requires X-Requested-With: pairprep header (enforced by csrfProtection).
 */
authRouter.post("/logout", (req: Request, res: Response) => {
  const finalizeLogout = () => {
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });
    res.json({ status: "ok" });
  };

  const destroySession = () => {
    if (req.session) {
      req.session.destroy((err) => {
        if (err) {
          rootLogger.warn({ err }, "Error destroying session during logout");
        }
        finalizeLogout();
      });
    } else {
      finalizeLogout();
    }
  };

  if (typeof req.logout === "function") {
    req.logout((err) => {
      if (err) {
        rootLogger.warn({ err }, "Error during passport logout");
      }
      destroySession();
    });
  } else {
    destroySession();
  }
});
