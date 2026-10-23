import { EventModel, IEvent } from "../models/events.js";

export class EventRepo {
  public async appendEvent(data: {
    roomId: string;
    userId: string;
    type: string;
    payload?: Record<string, unknown>;
  }): Promise<IEvent> {
    const event = new EventModel({
      roomId: data.roomId,
      userId: data.userId,
      type: data.type,
      payload: data.payload || {},
      ts: new Date(),
    });

    return event.save();
  }

  public async getEvents(roomId: string): Promise<IEvent[]> {
    return EventModel.find({ roomId }).sort({ ts: 1 }).exec();
  }

  public async deleteByRoom(roomId: string): Promise<number> {
    const result = await EventModel.deleteMany({ roomId }).exec();
    return result.deletedCount || 0;
  }
}

export const eventRepo = new EventRepo();
