import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { userRepo } from "../repos/userRepo.js";
import { toUserPrivateDto, UpdateProfileDtoSchema } from "@pairprep/shared";

export const meRouter = Router();

// PRD 6.1: Profile routes require authentication
meRouter.use(requireAuth);

// Apply Cache-Control: no-store to me endpoints
meRouter.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  next();
});

/**
 * GET /api/v1/me
 * Returns current user's private profile (including email, strictly for self)
 */
meRouter.get("/", (req: Request, res: Response) => {
  const user = req.user!;
  res.json(toUserPrivateDto(user));
});

/**
 * PATCH /api/v1/me
 * Updates user display name (1 to 40 characters after trimming, control characters stripped, reject empty)
 */
meRouter.patch("/", async (req: Request, res: Response, next: NextFunction) => {
  const parseResult = UpdateProfileDtoSchema.safeParse(req.body);

  const requestId =
    (res.getHeader("X-Request-Id") as string) ||
    (req.headers["x-request-id"] as string) ||
    "";

  if (!parseResult.success) {
    const message = parseResult.error.issues.map((i) => i.message).join("; ");
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message,
        requestId,
      },
    });
    return;
  }

  try {
    const updated = await userRepo.updateDisplayName(
      req.user!.id,
      parseResult.data.displayName
    );

    if (!updated) {
      res.status(404).json({
        error: {
          code: "USER_NOT_FOUND",
          message: "User account could not be found",
          requestId,
        },
      });
      return;
    }

    res.json(toUserPrivateDto(updated));
  } catch (err) {
    next(err);
  }
});
