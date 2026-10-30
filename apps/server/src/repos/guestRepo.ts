import { sanitizeDisplayName } from "@pairprep/shared";
import { GuestModel, IGuest } from "../models/guests.js";

export class GuestRepo {
  public async createGuest(
    displayName: string,
    roomId: string,
    expiresAt?: Date
  ): Promise<IGuest> {
    const cleanName = sanitizeDisplayName(displayName);
    const guest = new GuestModel({
      displayName: cleanName,
      roomId,
      createdAt: new Date(),
      expiresAt: expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days (PRD 12)
    });
    return guest.save();
  }

  public async findById(id: string): Promise<IGuest | null> {
    return GuestModel.findById(id).exec();
  }

  public async deleteGuest(id: string): Promise<boolean> {
    const result = await GuestModel.findByIdAndDelete(id).exec();
    return result !== null;
  }
}

export const guestRepo = new GuestRepo();
