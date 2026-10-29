import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as GitHubStrategy, Profile as GitHubProfile } from "passport-github2";
import { config } from "../config.js";
import { userRepo } from "../repos/userRepo.js";
import { IUser } from "../models/users.js";
import { rootLogger } from "../middleware/logger.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends IUser {}
  }
}

// Passport session serialization
passport.serializeUser((user: Express.User, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await userRepo.findById(id);
    if (!user || user.disabled) {
      return done(null, false);
    }
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

/**
 * Configure Google OAuth 2.0 Strategy
 */
export function configurePassport(): void {
  const googleClientId = config.GOOGLE_CLIENT_ID;
  const googleClientSecret = config.GOOGLE_CLIENT_SECRET;

  if (googleClientId && googleClientSecret) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: googleClientId,
          clientSecret: googleClientSecret,
          callbackURL:
            config.GOOGLE_CALLBACK_URL ||
            `${config.SITE_ORIGIN}/api/v1/auth/callback/google`,
          passReqToCallback: true,
          pkce: true,
          state: true,
        },
        async (_req, _accessToken, _refreshToken, profile, done) => {
          // Discard _accessToken and _refreshToken immediately
          try {
            // Google email only if verified
            const verifiedEmail =
              profile.emails?.find(
                (e: { verified?: boolean; value?: string }) => e.verified === true
              )?.value ||
              ((
                profile as unknown as {
                  _json?: { email_verified?: boolean; email?: string };
                }
              )._json?.email_verified
                ? profile.emails?.[0]?.value ||
                  (profile as unknown as { _json?: { email?: string } })._json?.email
                : null) ||
              null;

            const rawDisplayName =
              profile.displayName ||
              `${profile.name?.givenName || ""} ${profile.name?.familyName || ""}`.trim() ||
              "Google User";
            const displayName = [...rawDisplayName].slice(0, 40).join("");

            const rawAvatar = profile.photos?.[0]?.value;
            const avatarUrl =
              rawAvatar && rawAvatar.startsWith("https://") ? rawAvatar : undefined;

            const user = await userRepo.upsertUser({
              provider: "google",
              providerId: profile.id,
              displayName,
              email: verifiedEmail,
              avatarUrl,
            });

            if (user.disabled) {
              rootLogger.warn(
                { userId: user.id },
                "Google login rejected: user account is disabled"
              );
              return done(null, false, { message: "Account disabled" });
            }

            done(null, user);
          } catch (err) {
            rootLogger.error({ err }, "Google OAuth strategy verify failed");
            done(err as Error, undefined);
          }
        }
      )
    );
  }

  const githubClientId = config.GITHUB_CLIENT_ID;
  const githubClientSecret = config.GITHUB_CLIENT_SECRET;

  if (githubClientId && githubClientSecret) {
    passport.use(
      new GitHubStrategy(
        {
          clientID: githubClientId,
          clientSecret: githubClientSecret,
          callbackURL:
            config.GITHUB_CALLBACK_URL ||
            `${config.SITE_ORIGIN}/api/v1/auth/callback/github`,
          passReqToCallback: true,
          state: true as unknown as string,
        },
        async (
          _req: unknown,
          _accessToken: string,
          _refreshToken: string,
          profile: GitHubProfile,
          done: (err: unknown, user?: Express.User | false | null, info?: unknown) => void
        ) => {
          // Discard _accessToken and _refreshToken immediately
          try {
            // Find verified email from profile or null (no invented noreply)
            let verifiedEmail: string | null = null;
            if (Array.isArray(profile.emails) && profile.emails.length > 0) {
              const verifiedItem =
                profile.emails.find(
                  (e: { verified?: boolean; primary?: boolean; value?: string }) =>
                    e.verified === true && e.primary === true
                ) ||
                profile.emails.find(
                  (e: { verified?: boolean; value?: string }) => e.verified === true
                );
              verifiedEmail = verifiedItem?.value || null;
            }

            const rawDisplayName =
              profile.displayName || profile.username || "GitHub User";
            const displayName = [...rawDisplayName].slice(0, 40).join("");
            const rawAvatar = profile.photos?.[0]?.value;
            const avatarUrl =
              rawAvatar && rawAvatar.startsWith("https://") ? rawAvatar : undefined;

            const user = await userRepo.upsertUser({
              provider: "github",
              providerId: String(profile.id),
              displayName,
              email: verifiedEmail,
              avatarUrl,
            });

            if (user.disabled) {
              rootLogger.warn(
                { userId: user.id },
                "GitHub login rejected: user account is disabled"
              );
              return done(null, false, { message: "Account disabled" });
            }

            done(null, user);
          } catch (err) {
            rootLogger.error({ err }, "GitHub OAuth strategy verify failed");
            done(err, undefined);
          }
        }
      )
    );
  }
}

// Automatically configure on import
configurePassport();

export { passport };
