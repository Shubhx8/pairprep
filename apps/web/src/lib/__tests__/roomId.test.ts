import { describe, it, expect } from "vitest";
import { isValidRoomId, assertValidRoomId } from "../roomId.js";

describe("roomId validation", () => {
  it("accepts valid 24-character hexadecimal MongoDB ObjectIds", () => {
    expect(isValidRoomId("507f1f77bcf86cd799439011")).toBe(true);
    expect(isValidRoomId("000000000000000000000000")).toBe(true);
    expect(isValidRoomId("ffffffffffffffffffffffff")).toBe(true);
    expect(isValidRoomId("ABCDEF0123456789abcdef01")).toBe(true);
  });

  it("rejects room slugs", () => {
    expect(isValidRoomId("practice-session-alpha-492")).toBe(false);
    expect(isValidRoomId("interview-round-1")).toBe(false);
    expect(isValidRoomId("test-room-slug")).toBe(false);
  });

  it("rejects identifiers with invalid length", () => {
    expect(isValidRoomId("507f1f77bcf86cd79943901")).toBe(false); // 23 chars
    expect(isValidRoomId("507f1f77bcf86cd7994390111")).toBe(false); // 25 chars
    expect(isValidRoomId("")).toBe(false); // empty
  });

  it("rejects non-hexadecimal characters", () => {
    expect(isValidRoomId("507f1f77bcf86cd79943901g")).toBe(false);
    expect(isValidRoomId("507f1f77bcf86cd79943901Z")).toBe(false);
    expect(isValidRoomId("507f1f77bcf86cd79943901-")).toBe(false);
    expect(isValidRoomId("507f1f77bcf86cd79943901 ")).toBe(false);
  });

  it("rejects null, undefined, and non-string inputs", () => {
    expect(isValidRoomId(null)).toBe(false);
    expect(isValidRoomId(undefined)).toBe(false);
    expect(isValidRoomId(12345)).toBe(false);
    expect(isValidRoomId({})).toBe(false);
    expect(isValidRoomId(["507f1f77bcf86cd799439011"])).toBe(false);
  });

  describe("assertValidRoomId", () => {
    it("does not throw for valid ObjectId", () => {
      expect(() => assertValidRoomId("507f1f77bcf86cd799439011")).not.toThrow();
    });

    it("throws descriptive error for invalid identifier", () => {
      expect(() => assertValidRoomId("invalid-slug")).toThrow(
        /Invalid room document id: expected 24-character hexadecimal ObjectId/
      );
      expect(() => assertValidRoomId(null)).toThrow(
        /Invalid room document id: expected 24-character hexadecimal ObjectId/
      );
    });
  });
});
