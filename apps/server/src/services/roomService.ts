/**
 * T05: In-memory room state has been deleted.
 * All room operations are async and backed by MongoDB repositories (roomRepo, roomMemberRepo).
 */
export class RoomService {
  public reset(): void {
    // In-memory state removed in T05
  }
}

export const roomService = new RoomService();
