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
    email: string;
    role?: "user" | "owner-admin";
  }): Promise<IUser> {
    return UserModel.findOneAndUpdate(
      { provider: data.provider, providerId: data.providerId },
      {
        $set: {
          displayName: data.displayName,
          avatarUrl: data.avatarUrl,
          email: data.email,
          ...(data.role ? { role: data.role } : {}),
        },
        $setOnInsert: {
          createdAt: new Date(),
          disabled: false,
        },
      },
      { upsert: true, new: true, runValidators: true }
    ).exec();
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
