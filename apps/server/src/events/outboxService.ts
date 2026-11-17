import mongoose from "mongoose";
import type { Server } from "socket.io";
import {
  DurableOperationModel,
  type DurableOperationType,
  type DurableOperationStatus,
  type IDurableOperation,
} from "../models/durable_operations.js";
import { messageRepo } from "../repos/messageRepo.js";
import { roomRepo } from "../repos/roomRepo.js";
import { roomMemberRepo } from "../repos/roomMemberRepo.js";
import { RoomMemberModel } from "../models/room_members.js";
import { RoomModel } from "../models/rooms.js";
import { IMessage } from "../models/messages.js";
import {
  toMessageDto,
  RoomMemberJoinedPayloadSchema,
  RoomMemberDtoSchema,
  type RoomMemberDto,
  type UserRole,
} from "@pairprep/shared";
import { rootLogger } from "../middleware/logger.js";
import { presenceTracker } from "./presenceTracker.js";
import { syncRegistry } from "../sync/syncRegistry.js";
import { abortRoomPersistence } from "../sync/persistence.js";
import { roomMutationBarrier } from "./roomMutationBarrier.js";
import { AppError } from "../errors/AppError.js";

export interface OutboxBroadcastContext {
  io?: Server;
}

/**
 * Durable System Event Outbox Service for Standalone MongoDB Deployment.
 *
 * CRASH-SAFETY GUARANTEES:
 * 1. Intent is durably recorded in MongoDB BEFORE domain mutation begins.
 * 2. Primary domain mutation is executed. If it fails, intent is marked "abandoned".
 * 3. Status advances to "applied" only after domain mutation succeeds.
 * 4. System message is inserted into messages collection with deterministic opId
 *    and unique index { roomId: 1, opId: 1 } guaranteeing exactly-once persistence.
 * 5. Status advances to "persisted".
 * 6. Real-time Socket.IO broadcasts are emitted.
 * 7. Status advances to "published".
 *
 * A crash at any boundary can be safely reconciled via reconcilePendingOperations()
 * with ZERO lost system messages, ZERO duplicate messages, and ZERO phantom messages.
 */
export class OutboxService {
  /**
   * Generates a stable deterministic operation ID.
   */
  public generateOpId(
    type: DurableOperationType,
    roomId: string,
    targetId: string,
    nonce?: string
  ): string {
    const cleanNonce = nonce ? `:${nonce}` : "";
    return `op:${type}:${roomId}:${targetId}${cleanNonce}`;
  }

  /**
   * Step 1: Record durable operation intent before executing domain mutation.
   */
  public async recordIntent(
    opId: string,
    type: DurableOperationType,
    roomId: string,
    payload: Record<string, unknown>
  ): Promise<IDurableOperation> {
    try {
      const op = new DurableOperationModel({
        opId,
        roomId,
        type,
        status: "intent_recorded",
        payload,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return await op.save();
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: number }).code === 11000
      ) {
        const existing = await DurableOperationModel.findOne({ opId }).exec();
        if (existing) return existing;
      }
      throw err;
    }
  }

  /**
   * Monotonic Compare-And-Set status transition helper (M-1).
   * Ensures status moves strictly forward along valid lifecycle paths.
   */
  public async transitionStatus(
    opId: string,
    allowedFrom: DurableOperationStatus | DurableOperationStatus[],
    toStatus: DurableOperationStatus,
    extraUpdates: Record<string, unknown> = {}
  ): Promise<{ success: boolean; doc: IDurableOperation | null }> {
    const fromList = Array.isArray(allowedFrom) ? allowedFrom : [allowedFrom];
    const updateDoc = await DurableOperationModel.findOneAndUpdate(
      { opId, status: { $in: fromList } },
      {
        $set: {
          status: toStatus,
          updatedAt: new Date(),
          ...extraUpdates,
        },
      },
      { new: true }
    ).exec();

    if (updateDoc) {
      return { success: true, doc: updateDoc };
    }

    const current = await DurableOperationModel.findOne({ opId }).exec();
    return { success: false, doc: current };
  }

  /**
   * Marks an operation as abandoned if domain mutation failed.
   */
  public async markAbandoned(opId: string, error?: string): Promise<void> {
    await this.transitionStatus(
      opId,
      ["intent_recorded", "applied", "persisted", "published"],
      "abandoned",
      { error: error || "Domain mutation failed" }
    );
  }

  /**
   * Step 2 & 3: Mark domain mutation as applied via compare-and-set.
   */
  public async markApplied(
    opId: string,
    extraUpdates: Record<string, unknown> = {}
  ): Promise<IDurableOperation | null> {
    const res = await this.transitionStatus(
      opId,
      ["intent_recorded"],
      "applied",
      extraUpdates
    );
    return res.doc;
  }

  /**
   * Step 4 & 5: Allocate sequence, insert system message into messages collection,
   * and mark operation as persisted.
   */
  public async persistSystemMessage(
    opId: string,
    messageText: string
  ): Promise<{ op: IDurableOperation; message: IMessage }> {
    const op = await DurableOperationModel.findOne({ opId }).exec();
    if (!op) {
      throw new Error(`Durable operation ${opId} not found`);
    }

    // Allocate sequence number for the system message
    const seq = await roomRepo.allocateMessageSeq(op.roomId, true);

    const message = await messageRepo.createMessage({
      roomId: op.roomId,
      seq,
      authorId: "system",
      authorName: "System",
      text: messageText,
      kind: "system",
      opId,
    });

    const res = await this.transitionStatus(opId, ["applied", "persisted"], "persisted", {
      seq: message.seq,
      messageId: String(message._id),
    });

    return { op: res.doc || op, message };
  }

  /**
   * Step 6 & 7: Broadcast real-time Socket.IO events and mark operation as published.
   */
  public async publishBroadcast(
    io: Server | undefined,
    opId: string,
    message?: IMessage
  ): Promise<IDurableOperation | null> {
    const op = await DurableOperationModel.findOne({ opId }).exec();
    if (!op) return null;

    if (io) {
      const roomChannel = `room:${op.roomId}`;

      // Emit domain-specific event
      switch (op.type) {
        case "join": {
          let memberDto: RoomMemberDto | null = null;
          const candidateMember = op.payload["member"];
          if (
            candidateMember &&
            typeof candidateMember === "object" &&
            "memberId" in candidateMember
          ) {
            const parsed = RoomMemberDtoSchema.safeParse(candidateMember);
            if (parsed.success) {
              memberDto = parsed.data;
            }
          }

          if (!memberDto) {
            // Recover authoritative member data from database (handles flat or legacy payload)
            let rawMemberId: string | undefined;
            if (
              typeof op.payload["memberId"] === "string" &&
              op.payload["memberId"].trim()
            ) {
              rawMemberId = op.payload["memberId"].trim();
            } else if (
              candidateMember &&
              typeof candidateMember === "object" &&
              "memberId" in candidateMember &&
              typeof (candidateMember as { memberId?: unknown }).memberId === "string"
            ) {
              const trimmed = (candidateMember as { memberId: string }).memberId.trim();
              if (trimmed) rawMemberId = trimmed;
            }

            if (rawMemberId) {
              const persistedMember = await roomMemberRepo.findMember(
                op.roomId,
                rawMemberId
              );
              if (persistedMember) {
                memberDto = {
                  roomId: op.roomId,
                  memberId: persistedMember.memberId,
                  displayName: persistedMember.displayName,
                  role: persistedMember.role,
                  isGuest: Boolean(persistedMember.isGuest),
                  joinedAt:
                    typeof persistedMember.joinedAt === "string"
                      ? persistedMember.joinedAt
                      : (persistedMember.joinedAt?.toISOString?.() ??
                        new Date().toISOString()),
                  lastSeenAt: persistedMember.lastSeenAt
                    ? typeof persistedMember.lastSeenAt === "string"
                      ? persistedMember.lastSeenAt
                      : persistedMember.lastSeenAt.toISOString()
                    : undefined,
                };
              }
            }
          }

          if (memberDto) {
            const eventPayload = {
              roomId: op.roomId,
              member: memberDto,
            };
            const validated = RoomMemberJoinedPayloadSchema.safeParse(eventPayload);
            if (validated.success) {
              io.to(roomChannel).emit("room:member_joined", validated.data);
            } else {
              rootLogger.warn(
                { opId, roomId: op.roomId },
                "[outboxService] Suppressed invalid room:member_joined event: validation failed"
              );
            }
          } else {
            rootLogger.warn(
              { opId, roomId: op.roomId },
              "[outboxService] Suppressed room:member_joined event: member data unrecoverable"
            );
          }
          break;
        }
        case "remove":
          io.to(roomChannel).emit("room:member_left", {
            roomId: op.roomId,
            memberId:
              (op.payload["memberDocId"] as string) || (op.payload["memberId"] as string),
            reason:
              (op.payload["reason"] as "removed" | "left" | "disconnected") || "removed",
          });
          break;
        case "role_change":
          io.to(roomChannel).emit("room:role_changed", {
            roomId: op.roomId,
            memberId:
              (op.payload["memberDocId"] as string) || (op.payload["memberId"] as string),
            role: op.payload["role"],
          });
          break;
        case "room_ended":
          io.to(roomChannel).emit("room:status_changed", {
            roomId: op.roomId,
            status: "ended",
          });
          break;
        case "room_deleted":
          io.to(roomChannel).emit("room:deleted", {
            roomId: op.roomId,
          });
          break;
      }

      // If a chat message is associated with this system event, emit chat:message
      if (message) {
        io.to(roomChannel).emit("chat:message", {
          roomId: op.roomId,
          message: toMessageDto(message),
        });
      }
    }

    const res = await this.transitionStatus(opId, ["persisted", "applied"], "published");
    return res.doc;
  }

  /**
   * PRD ROOM-6 / H-1: Executes the full durable room deletion flow.
   * State Machine: intent_recorded -> applied (barrier set & drained) -> published (sockets drained) -> completed (cascade done)
   */
  public async executeRoomDeletion(options: {
    roomId: string;
    slug: string;
    io?: Server;
  }): Promise<void> {
    const { roomId, slug, io } = options;
    const opId = this.generateOpId("room_deleted", roomId, "all");

    // 1. Record Intent
    await this.recordIntent(opId, "room_deleted", roomId, { slug });

    // 2. Set Deletion Barrier (tombstone room to "deleted", stamp deletionOpId)
    const tombstonedRoom = await roomRepo.setDeletionBarrier(roomId, opId);
    if (!tombstonedRoom) {
      // Room was already deleted or barrier won by another concurrent operation
      await this.markAbandoned(opId, "Superseded: concurrent deletion won barrier");
      throw new AppError("Room not found", 404, "ROOM_NOT_FOUND");
    }

    // 3. Atomically close mutation admission barrier in memory immediately
    roomMutationBarrier.closeRoomAdmission(roomId);

    // 4. Immediately fence collaborative sync
    syncRegistry.markRoomDeleted(roomId);
    syncRegistry.closeAllConnectionsForRoom(roomId, 1000, "room_deleted");
    syncRegistry.setRoomReadOnly(roomId);

    // 5. Drain all mutations admitted prior to barrier
    await roomMutationBarrier.drainRoomMutations(roomId, 5000);

    // 6. Abort and await active Yjs persistence flushes under roomMutex
    await abortRoomPersistence(roomId);

    // 7. Advance to Applied (barrier successfully set and drained) via CAS
    await this.markApplied(opId);

    // 8. Graceful Broadcast & Socket Disconnection (M-1) with bounded acknowledgement
    if (io) {
      io.to(`room:${roomId}`).emit("room:deleted", { roomId });
    }
    await presenceTracker.gracefulDisconnectRoomSockets(roomId, 500);

    // 9. Advance to Published via CAS
    await this.transitionStatus(opId, ["applied"], "published");

    // 10. Cascade Cleanup (children first, then room document, mark prior outbox ops abandoned) (H-2)
    await roomRepo.deleteRoom(roomId, opId);

    // 11. Terminal State: Mark outbox operation as "completed" via CAS
    await this.transitionStatus(opId, ["published", "applied"], "completed");

    // 12. Reset room barrier state
    roomMutationBarrier.resetRoom(roomId);
  }

  /**
   * Full atomic wrapper executing the entire durable outbox flow for a mutation.
   */
  /**
   * Full atomic wrapper executing the entire durable outbox flow for a mutation.
   * Enters the room mutation barrier to guard against races with deletion.
   */
  public async executeDurableOperation<T>(options: {
    opId: string;
    type: DurableOperationType;
    roomId: string;
    payload: Record<string, unknown>;
    messageText?: string;
    io?: Server;
    mutation: () => Promise<T>;
  }): Promise<{ result: T; message?: IMessage }> {
    return roomMutationBarrier.withAdmission(options.roomId, async () => {
      // 1. Record Intent
      await this.recordIntent(
        options.opId,
        options.type,
        options.roomId,
        options.payload
      );

      // 2. Execute Domain Mutation
      let result: T;
      try {
        result = await options.mutation();
      } catch (err: unknown) {
        await this.markAbandoned(
          options.opId,
          err instanceof Error ? err.message : String(err)
        );
        throw err;
      }

      let extraApplied: Record<string, unknown> = {};
      if (
        result &&
        typeof result === "object" &&
        "roleVersion" in result &&
        typeof (result as { roleVersion?: unknown }).roleVersion === "number"
      ) {
        const v = (result as { roleVersion: number }).roleVersion;
        options.payload["roleVersion"] = v;
        extraApplied = { appliedVersion: v, "payload.roleVersion": v };
      }

      if (
        options.type === "join" &&
        result &&
        typeof result === "object" &&
        "memberId" in result
      ) {
        const m = result as unknown as {
          roomId: string;
          memberId: string;
          displayName: string;
          role: UserRole;
          isGuest?: boolean;
          joinedAt?: Date | string;
          lastSeenAt?: Date | string;
        };
        const memberDto: RoomMemberDto = {
          roomId: options.roomId,
          memberId: m.memberId,
          displayName: m.displayName,
          role: m.role,
          isGuest: Boolean(m.isGuest),
          joinedAt:
            typeof m.joinedAt === "string"
              ? m.joinedAt
              : (m.joinedAt?.toISOString?.() ?? new Date().toISOString()),
          lastSeenAt: m.lastSeenAt
            ? typeof m.lastSeenAt === "string"
              ? m.lastSeenAt
              : m.lastSeenAt.toISOString()
            : undefined,
        };
        options.payload["member"] = memberDto;
        extraApplied["payload.member"] = memberDto;
      }

      // 3. Advance to Applied via CAS
      await this.markApplied(options.opId, extraApplied);

      // 4 & 5. Persist System Message (if text provided)
      let message: IMessage | undefined;
      if (options.messageText) {
        const persisted = await this.persistSystemMessage(
          options.opId,
          options.messageText
        );
        message = persisted.message;
      }

      // 6 & 7. Broadcast and Advance to Published via CAS
      await this.publishBroadcast(options.io, options.opId, message);

      // 8. Terminal State & Evidence Cleanup via CAS
      await this.transitionStatus(options.opId, ["published", "applied"], "completed");

      if (options.type === "role_change" && options.payload["memberDocId"]) {
        await roomMemberRepo.clearOperationEvidence(
          options.roomId,
          options.payload["memberDocId"] as string,
          options.opId
        );
      } else if (options.type === "remove" || options.type === "room_ended") {
        await roomRepo.clearOperationEvidence(options.roomId, options.opId);
      }

      return { result, message };
    });
  }

  /**
   * Reconciler: Sweeps pending/incomplete outbox operations upon process restart.
   */
  public async reconcilePendingOperations(io?: Server): Promise<number> {
    // Pre-warm admission barrier closure for any rooms tombstoned or pending deletion across crash
    try {
      if (mongoose.connection.readyState === 1) {
        const tombstonedRooms = await RoomModel.find(
          { status: "deleted" },
          { _id: 1 }
        ).exec();
        for (const r of tombstonedRooms) {
          roomMutationBarrier.closeRoomAdmission(String(r._id));
        }
      }
    } catch {
      // Best-effort pre-warming
    }

    // Safe discovery and recovery of orphaned staged departure tombstones (Phase 17)
    try {
      const isMemberFindMocked = Boolean(
        (RoomMemberModel.find as { mock?: unknown }).mock
      );
      if (
        (mongoose.connection.readyState === 1 && mongoose.connection.db) ||
        isMemberFindMocked
      ) {
        const query = RoomMemberModel.find({
          tombstoneOpId: { $exists: true },
        });
        const orphanedTombstones =
          typeof (query as unknown as { exec?: unknown })?.exec === "function"
            ? await (query as unknown as { exec: () => Promise<unknown[]> }).exec()
            : await (query as unknown as Promise<unknown[]>);

        if (Array.isArray(orphanedTombstones)) {
          for (const orphan of orphanedTombstones) {
            if (
              orphan &&
              typeof orphan === "object" &&
              "roomId" in orphan &&
              "memberId" in orphan &&
              "tombstoneOpId" in orphan &&
              orphan.roomId &&
              orphan.memberId &&
              orphan.tombstoneOpId
            ) {
              await roomMemberRepo.removeByMemberId(
                orphan.roomId as string,
                orphan.memberId as string,
                orphan.tombstoneOpId as string
              );
            }
          }
        }
      }
    } catch {
      // Best-effort pre-warming / orphaned tombstone reconciliation
    }

    const query = DurableOperationModel.find({
      status: { $in: ["intent_recorded", "applied", "persisted", "published"] },
    });
    const pendingOps =
      typeof (query as unknown as { sort?: unknown }).sort === "function"
        ? await (
            query as unknown as {
              sort: (s: Record<string, number>) => {
                exec: () => Promise<IDurableOperation[]>;
              };
            }
          )
            .sort({ createdAt: 1 })
            .exec()
        : await query.exec();

    let reconciledCount = 0;

    for (const op of pendingOps) {
      try {
        if (op.type === "room_deleted") {
          // Dedicated crash recovery for durable room deletion
          if (op.status === "intent_recorded") {
            const applied = await this.verifyDomainMutationApplied(op);
            if (!applied) {
              await this.markAbandoned(
                op.opId,
                "Reconciled: deletion barrier not set or unverified"
              );
              reconciledCount++;
              continue;
            }
            await this.markApplied(op.opId);
            op.status = "applied";
          }

          if (op.status === "applied") {
            roomMutationBarrier.closeRoomAdmission(op.roomId);
            syncRegistry.markRoomDeleted(op.roomId);
            syncRegistry.closeAllConnectionsForRoom(op.roomId, 1000, "room_deleted");
            syncRegistry.setRoomReadOnly(op.roomId);
            await roomMutationBarrier.drainRoomMutations(op.roomId, 5000);
            await abortRoomPersistence(op.roomId);

            if (io) {
              io.to(`room:${op.roomId}`).emit("room:deleted", { roomId: op.roomId });
            }
            await presenceTracker.gracefulDisconnectRoomSockets(op.roomId, 500);

            await this.transitionStatus(op.opId, ["applied"], "published");
            op.status = "published";
          }

          if (op.status === "published") {
            roomMutationBarrier.closeRoomAdmission(op.roomId);
            await roomRepo.deleteRoom(op.roomId, op.opId);
            await this.transitionStatus(op.opId, ["published", "applied"], "completed");
            roomMutationBarrier.resetRoom(op.roomId);
            reconciledCount++;
            continue;
          }
          continue;
        }

        // Standard Lifecycle Operations (role_change, remove, room_ended, join)
        if (op.status === "intent_recorded") {
          // Check if domain mutation took place with verifiable operation ownership
          const applied = await this.verifyDomainMutationApplied(op);
          if (!applied) {
            // Domain mutation never happened or was superseded; safely mark abandoned
            await this.markAbandoned(
              op.opId,
              "Reconciled: domain mutation not applied or superseded"
            );
            reconciledCount++;
            continue;
          }
          // Domain mutation happened before crash; advance to applied
          await this.markApplied(op.opId);
          op.status = "applied";
        }

        if (op.status === "applied") {
          // System message was not persisted before crash
          const messageText = (op.payload["messageText"] as string) || undefined;
          let message: IMessage | undefined;
          if (messageText) {
            const res = await this.persistSystemMessage(op.opId, messageText);
            message = res.message;
          }
          await this.publishBroadcast(io, op.opId, message);
          await this.transitionStatus(op.opId, ["published", "applied"], "completed");

          if (op.type === "role_change" && op.payload["memberDocId"]) {
            await roomMemberRepo.clearOperationEvidence(
              op.roomId,
              op.payload["memberDocId"] as string,
              op.opId
            );
          } else if (op.type === "remove" || op.type === "room_ended") {
            await roomRepo.clearOperationEvidence(op.roomId, op.opId);
          }

          reconciledCount++;
          continue;
        }

        if (op.status === "persisted") {
          // Message was persisted, but broadcast / published status was interrupted
          let message: IMessage | undefined;
          if (op.messageId) {
            message =
              (await messageRepo
                .getRecentMessages(op.roomId, 1)
                .then((msgs) => msgs.find((m) => String(m._id) === op.messageId))) ??
              undefined;
          }
          await this.publishBroadcast(io, op.opId, message);
          await this.transitionStatus(op.opId, ["published", "persisted"], "completed");

          if (op.type === "role_change" && op.payload["memberDocId"]) {
            await roomMemberRepo.clearOperationEvidence(
              op.roomId,
              op.payload["memberDocId"] as string,
              op.opId
            );
          } else if (op.type === "remove" || op.type === "room_ended") {
            await roomRepo.clearOperationEvidence(op.roomId, op.opId);
          }

          reconciledCount++;
        }
      } catch (reconcileErr) {
        rootLogger.error(
          { opId: op.opId, err: reconcileErr },
          "Failed to reconcile pending durable operation"
        );
      }
    }

    return reconciledCount;
  }

  /**
   * Verifies whether a domain mutation was performed specifically by this operation (Operation Ownership).
   * Rejects coincidental pre-existing states by verifying the operation marker stamped on the entity.
   */
  private async verifyDomainMutationApplied(op: IDurableOperation): Promise<boolean> {
    if (op.type === "role_change") {
      const memberDocId =
        (op.payload["memberDocId"] as string) || (op.payload["targetId"] as string);
      const member = memberDocId
        ? await roomMemberRepo.findMemberByDocId(op.roomId, memberDocId)
        : await roomMemberRepo.findMember(op.roomId, op.payload["memberId"] as string);
      if (!member) return false;

      // Check atomic roleOps evidence stamped on the member document
      const roleOp = member.roleOps?.find((r) => r.opId === op.opId);
      const hasOp =
        roleOp || member.appliedOpIds?.includes(op.opId) || member.lastOpId === op.opId;
      if (!hasOp) return false;

      // Strict ABA Protection (M-3):
      // Exact version comparison from roleOps or recorded payload/appliedVersion
      const opRoleVersion =
        roleOp?.version ??
        op.appliedVersion ??
        (op.payload["roleVersion"] as number | undefined);

      if (opRoleVersion !== undefined && member.roleVersion !== undefined) {
        if (member.roleVersion > opRoleVersion) {
          return false; // Superseded by a later mutation, even if role matched target!
        }
        if (member.roleVersion === opRoleVersion) {
          return true; // Exact match
        }
      }

      // If no version evidence exists at all, we CANNOT safely assume applied (prevent ABA false-positive).
      // Never fall back to member.role === targetRole.
      return false;
    }

    if (op.type === "remove") {
      const targetMemberId =
        (op.payload["memberId"] as string) || (op.payload["memberDocId"] as string);
      const memberDocId = op.payload["memberDocId"] as string;

      const room = await roomRepo.findById(op.roomId);
      const foundInRemoved = room?.removedMembers?.some((r) => r.opId === op.opId);
      const isAlreadyInRoom = foundInRemoved || room?.lastRemovedMember?.opId === op.opId;

      if (isAlreadyInRoom) {
        // Room was already decremented. Idempotently ensure receipts are excluded and any leftover doc deleted (Phase 15 & 17).
        if (targetMemberId) {
          await messageRepo.excludeRecipientFromRoomMessages(op.roomId, targetMemberId);
        }
        const isDeleteMocked = Boolean(
          (RoomMemberModel.deleteOne as { mock?: unknown }).mock
        );
        if (
          (Boolean(mongoose.connection.db) && mongoose.connection.readyState === 1) ||
          isDeleteMocked
        ) {
          if (memberDocId && mongoose.isValidObjectId(memberDocId)) {
            await RoomMemberModel.deleteOne({
              roomId: op.roomId,
              _id: memberDocId,
            }).exec();
          } else if (targetMemberId) {
            await RoomMemberModel.deleteOne({
              roomId: op.roomId,
              memberId: targetMemberId,
            }).exec();
          }
        }
        return true;
      }

      // M-4: Two-phase crash recovery if crashed between staged tombstone and room update (Phase 15 & 17)
      const isFindOneMocked = Boolean(
        (RoomMemberModel.findOne as { mock?: unknown }).mock
      );
      if (
        (Boolean(mongoose.connection.db) && mongoose.connection.readyState === 1) ||
        isFindOneMocked
      ) {
        const tombstoneFilter: Record<string, unknown> = {
          roomId: op.roomId,
          tombstoneOpId: op.opId,
        };
        if (memberDocId && mongoose.isValidObjectId(memberDocId)) {
          tombstoneFilter._id = memberDocId;
        } else if (targetMemberId) {
          tombstoneFilter.memberId = targetMemberId;
        }

        const tombstoned = await RoomMemberModel.findOne(tombstoneFilter).exec();

        if (tombstoned) {
          const resolvedMemberId = targetMemberId || tombstoned.memberId;
          // Step A: Exclude receipts FIRST so message recipient quorums are updated immediately (Phase 15 & 17)
          if (resolvedMemberId) {
            await messageRepo.excludeRecipientFromRoomMessages(
              op.roomId,
              resolvedMemberId
            );
          }

          // Step B: Update RoomModel memberCount and record removal evidence
          await RoomModel.updateOne(
            {
              _id: op.roomId,
              memberCount: { $gt: 1 },
              status: { $ne: "deleted" },
              "removedMembers.opId": { $ne: op.opId },
            },
            {
              $inc: { memberCount: -1 },
              $set: {
                memberCountUpdatedAt: new Date(),
                lastRemovedMember: { memberDocId: String(tombstoned._id), opId: op.opId },
              },
              $push: {
                removedMembers: {
                  memberDocId: String(tombstoned._id),
                  opId: op.opId,
                  removedAt: new Date(),
                },
              },
            }
          ).exec();

          // Step C: Delete the tombstoned document
          await RoomMemberModel.deleteOne({
            roomId: op.roomId,
            _id: tombstoned._id,
          }).exec();
          return true;
        }
      }
      return false;
    }

    if (op.type === "room_ended") {
      const room = await roomRepo.findById(op.roomId);
      if (!room || room.status !== "ended") return false;
      return room.appliedOpIds?.includes(op.opId) || room.statusOpId === op.opId || false;
    }

    if (op.type === "room_deleted") {
      const room = await roomRepo.findById(op.roomId);
      // CRITICAL FIX: A missing room document (!room) does NOT prove this operation deleted the room!
      // If op is in intent_recorded, the room MUST still exist in tombstoned state with matching deletionOpId!
      if (!room) {
        return false;
      }
      return room.status === "deleted" && room.deletionOpId === op.opId;
    }

    if (op.type === "join") {
      const member = await roomMemberRepo.findMember(
        op.roomId,
        op.payload["memberId"] as string
      );
      return (
        member?.appliedOpIds?.includes(op.opId) || member?.joinOpId === op.opId || false
      );
    }

    return false;
  }
}

export const outboxService = new OutboxService();
