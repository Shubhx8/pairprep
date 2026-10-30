import { UserModel, IUser } from "../models/users.js";

export class UserRepo {
  public async findById(id: string): Promise<IUser | null> {
    return UserModel.findById(id).exec();
  }

  public async findByProvider(
    provider: "google" | "github",
    providerId: string
  ): Promise<IUser | null> {
    return UserModel.findOne({ provider, providerId }).exec();
  }

  public async upsertUser(data: {
    provider: "google" | "github";
    providerId: string;
    displayName: string;
    avatarUrl?: string;
    email?: string | null;
    role?: "user" | "owner-admin";
  }): Promise<IUser> {
    const filter = { provider: data.provider, providerId: data.providerId };
    const safeAvatarUrl =
      data.avatarUrl && data.avatarUrl.startsWith("https://")
        ? data.avatarUrl
        : undefined;

    const setFields: Record<string, unknown> = {
      lastLoginAt: new Date(),
    };
    if (data.email != null) {
      setFields["email"] = data.email;
    }

    const update = {
      $setOnInsert: {
        displayName: data.displayName,
        avatarUrl: safeAvatarUrl,
        role: data.role || "user",
        createdAt: new Date(),
        disabled: false,
      },
      $set: setFields,
    };

    try {
      const user = await UserModel.findOneAndUpdate(filter, update, {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      }).exec();
      return user!;
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: number }).code === 11000
      ) {
        const existing = await UserModel.findOne(filter).exec();
        if (existing) {
          return existing;
        }
      }
      throw err;
    }
  }

  public async updateDisplayName(id: string, displayName: string): Promise<IUser | null> {
    return UserModel.findByIdAndUpdate(
      id,
      { $set: { displayName } },
      { new: true, runValidators: true }
    ).exec();
  }
}

export const userRepo = new UserRepo();
