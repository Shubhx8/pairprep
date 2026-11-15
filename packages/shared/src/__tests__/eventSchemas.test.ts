import { describe, it, expect } from "vitest";
import {
  ObjectIdSchema,
  EventErrorCode,
  EventErrorCodeSchema,
  EventErrorDtoSchema,
  EventErrorAckSchema,
  RoomJoinPayloadSchema,
  RoomJoinAckDataSchema,
  RoomJoinAckSchema,
  RoomLeavePayloadSchema,
  RoomLeaveAckDataSchema,
  RoomLeaveAckSchema,
  ChatSendPayloadSchema,
  ChatSendAckDataSchema,
  ChatSendAckSchema,
  RoomMemberJoinedPayloadSchema,
  RoomMemberLeftPayloadSchema,
  RoomRoleChangedPayloadSchema,
  RoomStatusChangedPayloadSchema,
  RoomDeletedPayloadSchema,
  ChatMessagePayloadSchema,
  ChatHistoryQuerySchema,
  ClientEventName,
  ServerEventName,
} from "../events/index.js";

describe("T09 Phase 1 Shared Event Protocol & Schemas", () => {
  const validObjectId = "507f1f77bcf86cd799439011";
  const validIsoDate = new Date().toISOString();

  describe("1. Canonical Event Names", () => {
    it("defines standard client-to-server event names", () => {
      expect(ClientEventName.ROOM_JOIN).toBe("room:join");
      expect(ClientEventName.ROOM_LEAVE).toBe("room:leave");
      expect(ClientEventName.CHAT_SEND).toBe("chat:send");
    });

    it("defines standard server-to-client event names", () => {
      expect(ServerEventName.ROOM_MEMBER_JOINED).toBe("room:member_joined");
      expect(ServerEventName.ROOM_MEMBER_LEFT).toBe("room:member_left");
      expect(ServerEventName.ROOM_ROLE_CHANGED).toBe("room:role_changed");
      expect(ServerEventName.ROOM_STATUS_CHANGED).toBe("room:status_changed");
      expect(ServerEventName.ROOM_DELETED).toBe("room:deleted");
      expect(ServerEventName.CHAT_MESSAGE).toBe("chat:message");
      expect(ServerEventName.ERROR).toBe("room:error");
    });
  });

  describe("2. ObjectId Validation", () => {
    it("accepts valid 24-character hexadecimal ObjectId", () => {
      expect(ObjectIdSchema.parse("507f1f77bcf86cd799439011")).toBe(
        "507f1f77bcf86cd799439011"
      );
      expect(ObjectIdSchema.parse("000000000000000000000000")).toBe(
        "000000000000000000000000"
      );
      expect(ObjectIdSchema.parse("ABCDEFabcdef012345678901")).toBe(
        "ABCDEFabcdef012345678901"
      );
    });

    it("rejects malformed ObjectIds", () => {
      // Too short
      expect(() => ObjectIdSchema.parse("507f1f77bcf86cd79943901")).toThrow();
      // Too long
      expect(() => ObjectIdSchema.parse("507f1f77bcf86cd7994390110")).toThrow();
      // Non-hex characters
      expect(() => ObjectIdSchema.parse("507f1f77bcf86cd79943901g")).toThrow();
      // Empty string
      expect(() => ObjectIdSchema.parse("")).toThrow();
      // Non-string
      expect(() => ObjectIdSchema.parse(1234567890123456)).toThrow();
      expect(() => ObjectIdSchema.parse(null)).toThrow();
      expect(() => ObjectIdSchema.parse(undefined)).toThrow();
    });
  });

  describe("3. Error Codes & Structured Error Acknowledgements", () => {
    it("validates all canonical error codes", () => {
      expect(EventErrorCodeSchema.parse(EventErrorCode.UNAUTHENTICATED)).toBe(
        "UNAUTHENTICATED"
      );
      expect(EventErrorCodeSchema.parse(EventErrorCode.FORBIDDEN)).toBe("FORBIDDEN");
      expect(EventErrorCodeSchema.parse(EventErrorCode.NOT_ROOM_MEMBER)).toBe(
        "NOT_ROOM_MEMBER"
      );
      expect(EventErrorCodeSchema.parse(EventErrorCode.ROOM_CLOSED)).toBe("ROOM_CLOSED");
      expect(EventErrorCodeSchema.parse(EventErrorCode.ROOM_DELETED)).toBe(
        "ROOM_DELETED"
      );
      expect(EventErrorCodeSchema.parse(EventErrorCode.RATE_LIMITED)).toBe(
        "RATE_LIMITED"
      );
      expect(EventErrorCodeSchema.parse(EventErrorCode.INTERNAL_ERROR)).toBe(
        "INTERNAL_ERROR"
      );
      expect(() => EventErrorCodeSchema.parse("UNKNOWN_CODE")).toThrow();
    });

    it("accepts valid error DTO and error acknowledgement", () => {
      const validError = {
        code: "NOT_ROOM_MEMBER" as const,
        message: "You are not an active member of this room",
        retryAfter: 5,
        details: { roomId: validObjectId },
      };
      expect(EventErrorDtoSchema.parse(validError)).toEqual(validError);

      const ack = {
        ok: false as const,
        error: validError,
      };
      expect(EventErrorAckSchema.parse(ack)).toEqual(ack);
    });

    it("rejects error DTO with unknown fields or missing message", () => {
      expect(() =>
        EventErrorDtoSchema.parse({
          code: "NOT_ROOM_MEMBER",
          message: "Error",
          extraField: "leak",
        })
      ).toThrow();

      expect(() =>
        EventErrorDtoSchema.parse({
          code: "NOT_ROOM_MEMBER",
        })
      ).toThrow();
    });
  });

  describe("4. room:join Payload & Acknowledgement", () => {
    it("accepts valid room:join payload", () => {
      const payload = { roomId: validObjectId };
      expect(RoomJoinPayloadSchema.parse(payload)).toEqual(payload);
    });

    it("rejects room:join with unknown fields", () => {
      expect(() =>
        RoomJoinPayloadSchema.parse({
          roomId: validObjectId,
          role: "owner", // Clients must NOT supply role
        })
      ).toThrow();
    });

    it("rejects room:join with invalid roomId", () => {
      expect(() => RoomJoinPayloadSchema.parse({ roomId: "invalid" })).toThrow();
      expect(() => RoomJoinPayloadSchema.parse({})).toThrow();
    });

    it("validates successful room:join acknowledgement", () => {
      const ackData = {
        roomId: validObjectId,
        role: "editor" as const,
        status: "open" as const,
      };
      expect(RoomJoinAckDataSchema.parse(ackData)).toEqual(ackData);

      const fullAck = {
        ok: true as const,
        data: ackData,
      };
      expect(RoomJoinAckSchema.parse(fullAck)).toEqual(fullAck);
    });

    it("rejects room:join acknowledgement with invalid role or status", () => {
      expect(() =>
        RoomJoinAckDataSchema.parse({
          roomId: validObjectId,
          role: "superadmin",
          status: "open",
        })
      ).toThrow();

      expect(() =>
        RoomJoinAckDataSchema.parse({
          roomId: validObjectId,
          role: "editor",
          status: "destroyed",
        })
      ).toThrow();
    });
  });

  describe("5. room:leave Payload & Acknowledgement", () => {
    it("accepts valid room:leave payload", () => {
      const payload = { roomId: validObjectId };
      expect(RoomLeavePayloadSchema.parse(payload)).toEqual(payload);
    });

    it("rejects room:leave with unknown fields", () => {
      expect(() =>
        RoomLeavePayloadSchema.parse({
          roomId: validObjectId,
          extra: true,
        })
      ).toThrow();
    });

    it("validates room:leave acknowledgement", () => {
      const data = { roomId: validObjectId, left: true as const };
      expect(RoomLeaveAckDataSchema.parse(data)).toEqual(data);
      const fullAck = {
        ok: true as const,
        data,
      };
      expect(RoomLeaveAckSchema.parse(fullAck)).toEqual(fullAck);
    });
  });

  describe("6. chat:send Payload & Acknowledgement", () => {
    it("accepts valid chat:send payload with canonical clientMsgId", () => {
      const payload = {
        roomId: validObjectId,
        text: "Hello, pair programming partner!",
        clientMsgId: "msg_client_12345",
      };
      expect(ChatSendPayloadSchema.parse(payload)).toEqual(payload);
    });

    it("rejects chat:send without required clientMsgId", () => {
      const payload = {
        roomId: validObjectId,
        text: "Simple text message",
      };
      expect(() => ChatSendPayloadSchema.parse(payload)).toThrow();
    });

    it("trims whitespace from chat text", () => {
      const parsed = ChatSendPayloadSchema.parse({
        roomId: validObjectId,
        text: "   trimmed text   ",
        clientMsgId: "msg_client_trim",
      });
      expect(parsed.text).toBe("trimmed text");
    });

    it("rejects empty or whitespace-only chat text", () => {
      expect(() =>
        ChatSendPayloadSchema.parse({
          roomId: validObjectId,
          text: "",
          clientMsgId: "msg_client_empty",
        })
      ).toThrow();

      expect(() =>
        ChatSendPayloadSchema.parse({
          roomId: validObjectId,
          text: "     ",
          clientMsgId: "msg_client_ws",
        })
      ).toThrow();
    });

    it("rejects chat text exceeding 1000 characters", () => {
      const oversizedText = "a".repeat(1001);
      expect(() =>
        ChatSendPayloadSchema.parse({
          roomId: validObjectId,
          text: oversizedText,
          clientMsgId: "msg_client_oversized",
        })
      ).toThrow();

      // Exactly 1000 characters is accepted
      const exactly1000 = "a".repeat(1000);
      expect(
        ChatSendPayloadSchema.parse({
          roomId: validObjectId,
          text: exactly1000,
          clientMsgId: "msg_client_exact1000",
        }).text.length
      ).toBe(1000);
    });

    it("rejects oversized clientMsgId", () => {
      expect(() =>
        ChatSendPayloadSchema.parse({
          roomId: validObjectId,
          text: "Valid text",
          clientMsgId: "x".repeat(65),
        })
      ).toThrow();
    });

    it("rejects unknown fields in chat:send", () => {
      expect(() =>
        ChatSendPayloadSchema.parse({
          roomId: validObjectId,
          text: "Valid text",
          clientMsgId: "msg_client_unknown",
          authorId: "spoofed_author", // Author MUST come from socket principal
        })
      ).toThrow();
    });

    it("validates successful chat:send acknowledgement", () => {
      const ackData = {
        messageId: validObjectId,
        seq: 42,
        ts: validIsoDate,
      };
      expect(ChatSendAckDataSchema.parse(ackData)).toEqual(ackData);
      const fullAck = {
        ok: true as const,
        data: ackData,
      };
      expect(ChatSendAckSchema.parse(fullAck)).toEqual(fullAck);
    });
  });

  describe("7. Server Broadcast Event Payloads", () => {
    it("validates room:member_joined payload", () => {
      const payload = {
        roomId: validObjectId,
        member: {
          roomId: validObjectId,
          memberId: "user_123",
          displayName: "Aarav",
          role: "editor" as const,
          isGuest: false,
          joinedAt: validIsoDate,
        },
      };
      expect(RoomMemberJoinedPayloadSchema.parse(payload)).toEqual(payload);
    });

    it("validates room:member_left payload", () => {
      const payload = {
        roomId: validObjectId,
        memberId: "user_123",
        reason: "removed" as const,
      };
      expect(RoomMemberLeftPayloadSchema.parse(payload)).toEqual(payload);
    });

    it("validates room:role_changed payload", () => {
      const payload = {
        roomId: validObjectId,
        memberId: "user_123",
        role: "viewer" as const,
      };
      expect(RoomRoleChangedPayloadSchema.parse(payload)).toEqual(payload);
    });

    it("validates room:status_changed payload", () => {
      const payload = {
        roomId: validObjectId,
        status: "ended" as const,
      };
      expect(RoomStatusChangedPayloadSchema.parse(payload)).toEqual(payload);
    });

    it("validates room:deleted payload", () => {
      const payload = {
        roomId: validObjectId,
      };
      expect(RoomDeletedPayloadSchema.parse(payload)).toEqual(payload);
    });

    it("validates chat:message broadcast payload", () => {
      const payload = {
        roomId: validObjectId,
        message: {
          id: validObjectId,
          roomId: validObjectId,
          authorId: "user_123",
          text: "Broadcast message",
          ts: validIsoDate,
          kind: "user" as const,
        },
      };
      expect(ChatMessagePayloadSchema.parse(payload)).toEqual(payload);
    });
  });

  describe("8. ChatHistoryQuerySchema", () => {
    it("defaults limit to 50 when omitted", () => {
      const parsed = ChatHistoryQuerySchema.parse({});
      expect(parsed.limit).toBe(50);
    });

    it("accepts limit of 200", () => {
      const parsed = ChatHistoryQuerySchema.parse({ limit: 200 });
      expect(parsed.limit).toBe(200);
    });

    it("coerces string limit to number", () => {
      const parsed = ChatHistoryQuerySchema.parse({ limit: "200" });
      expect(parsed.limit).toBe(200);
    });

    it("rejects limit of 201", () => {
      expect(() => ChatHistoryQuerySchema.parse({ limit: 201 })).toThrow();
    });

    it("rejects limit of 0 or negative", () => {
      expect(() => ChatHistoryQuerySchema.parse({ limit: 0 })).toThrow();
      expect(() => ChatHistoryQuerySchema.parse({ limit: -5 })).toThrow();
    });

    it("accepts valid beforeSeq and afterSeq cursors", () => {
      const parsed = ChatHistoryQuerySchema.parse({
        limit: 100,
        beforeSeq: 50,
        afterSeq: 10,
      });
      expect(parsed.limit).toBe(100);
      expect(parsed.beforeSeq).toBe(50);
      expect(parsed.afterSeq).toBe(10);
    });

    it("rejects unknown query fields", () => {
      expect(() =>
        ChatHistoryQuerySchema.parse({
          limit: 50,
          unknownParam: "malicious",
        })
      ).toThrow();
    });
  });
});
