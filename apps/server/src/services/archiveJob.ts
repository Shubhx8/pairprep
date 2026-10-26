import { roomRepo } from "../repos/roomRepo.js";
import { roomMemberRepo } from "../repos/roomMemberRepo.js";
import { rootLogger } from "../middleware/logger.js";

/**
 * Runs the daily maintenance tasks:
 * 1. Archives rooms idle for >= 30 days.
 * 2. Purges expired guest memberships and conditionally decrements memberCount.
 */
export async function runArchiveAndPurgeJobOnce(now: Date = new Date()): Promise<{
  archivedCount: number;
  purgedGuestsCount: number;
}> {
  try {
    // 1. Rooms idle >= 30 days become archived
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const archivedCount = await roomRepo.archiveInactiveRooms(thirtyDaysAgo);

    // 2. Purge expired guest members using distinct roomId query and atomic per-room decrements
    const purgedGuestsCount = await roomMemberRepo.purgeExpiredGuestMembers(now);

    rootLogger.info(
      { archivedCount, purgedGuestsCount },
      "[ArchiveJob] Inactivity archive and expired guest purge complete"
    );

    return { archivedCount, purgedGuestsCount };
  } catch (err) {
    rootLogger.error({ err }, "[ArchiveJob] Error during daily archive and purge run");
    return { archivedCount: 0, purgedGuestsCount: 0 };
  }
}

let archiveInterval: NodeJS.Timeout | undefined;

/**
 * Starts the in-process archive and purge schedule (runs on startup and every 24 hours).
 */
export function startArchiveJob(): void {
  // Run on startup
  runArchiveAndPurgeJobOnce().catch((err) => {
    rootLogger.error({ err }, "[ArchiveJob] Startup run failed");
  });

  // Schedule daily interval (24 hours) unreferenced so it does not block process exit
  if (!archiveInterval) {
    archiveInterval = setInterval(
      () => {
        runArchiveAndPurgeJobOnce().catch((err) => {
          rootLogger.error({ err }, "[ArchiveJob] Daily scheduled run failed");
        });
      },
      24 * 60 * 60 * 1000
    );
    archiveInterval.unref();
  }
}

/**
 * Stops the scheduled interval (useful for tests and graceful shutdown).
 */
export function stopArchiveJob(): void {
  if (archiveInterval) {
    clearInterval(archiveInterval);
    archiveInterval = undefined;
  }
}
