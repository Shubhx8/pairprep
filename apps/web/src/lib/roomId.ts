const MONGO_OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

/**
 * Validates whether a value is a valid 24-character hexadecimal MongoDB ObjectId.
 * T07 sync server strictly rejects any documentName that does not match /^[0-9a-fA-F]{24}$/.
 *
 * Rejects slugs, empty strings, null/undefined, and malformed strings.
 */
export function isValidRoomId(roomId: unknown): roomId is string {
  return typeof roomId === "string" && MONGO_OBJECT_ID_REGEX.test(roomId);
}

/**
 * Asserts that a roomId is a valid MongoDB ObjectId; throws Error if invalid.
 */
export function assertValidRoomId(roomId: unknown): asserts roomId is string {
  if (!isValidRoomId(roomId)) {
    throw new Error(
      "Invalid room document id: expected 24-character hexadecimal ObjectId"
    );
  }
}
