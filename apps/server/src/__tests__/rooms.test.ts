import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../index.js";
import { roomService } from "../services/roomService.js";

describe("Room API Endpoints (PRD 6.1, 6.2, 13.1)", () => {
  beforeEach(() => {
    roomService.reset();
  });

  describe("POST /api/v1/rooms (ROOM-1, CONC-3)", () => {
    it("creates a room with an unguessable 128-bit slug and owner member", async () => {
      const res = await request(app).post("/api/v1/rooms").send({
        title: "System Design Mock",
        type: "practice",
        language: "python",
        ownerName: "Meera",
      });

      expect(res.status).toBe(201);
      expect(res.body.room).toBeDefined();
      expect(res.body.room.title).toBe("System Design Mock");
      expect(res.body.room.slug).toMatch(/^[a-f0-9]{32}$/); // 16 bytes = 32 hex chars (128 bits)
      expect(res.body.room.members).toHaveLength(1);
      expect(res.body.room.members[0].role).toBe("owner");
      expect(res.body.room.members[0].displayName).toBe("Meera");
      expect(res.body.currentMember.role).toBe("owner");
    });

    it("rejects invalid room creation payloads (Zod validation)", async () => {
      const res = await request(app).post("/api/v1/rooms").send({
        title: "", // empty title forbidden
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_REQUEST");
    });

    it("supports idempotent creation with x-idempotency-key (CONC-3)", async () => {
      const payload = {
        title: "Idempotency Test",
        type: "practice",
        language: "javascript",
      };

      const res1 = await request(app)
        .post("/api/v1/rooms")
        .set("x-idempotency-key", "idem-key-12345")
        .send(payload);

      const res2 = await request(app)
        .post("/api/v1/rooms")
        .set("x-idempotency-key", "idem-key-12345")
        .send(payload);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body.room.id).toBe(res2.body.room.id);
      expect(res1.body.room.slug).toBe(res2.body.room.slug);
    });
  });

  describe("GET /api/v1/rooms/:slug (ROOM-2)", () => {
    it("fetches an existing room by slug", async () => {
      const created = await request(app).post("/api/v1/rooms").send({
        title: "Graph Algorithms",
        language: "cpp",
      });

      const slug = created.body.room.slug;

      const res = await request(app).get(`/api/v1/rooms/${slug}`);
      expect(res.status).toBe(200);
      expect(res.body.room.slug).toBe(slug);
      expect(res.body.room.title).toBe("Graph Algorithms");
    });

    it("returns 404 for non-existent room slug", async () => {
      const res = await request(app).get("/api/v1/rooms/non-existent-slug-xyz");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("ROOM_NOT_FOUND");
    });
  });

  describe("POST /api/v1/rooms/:slug/join (AUTH-3, ROOM-2, ROOM-4)", () => {
    it("allows a guest to join a room with a display name and unique color", async () => {
      const created = await request(app).post("/api/v1/rooms").send({
        title: "Two Sum Practice",
      });
      const slug = created.body.room.slug;

      const joinRes = await request(app)
        .post(`/api/v1/rooms/${slug}/join`)
        .send({ displayName: "Aarav Candidate" });

      expect(joinRes.status).toBe(200);
      expect(joinRes.body.room.members).toHaveLength(2);
      expect(joinRes.body.currentMember.displayName).toBe("Aarav Candidate");
      expect(joinRes.body.currentMember.role).toBe("editor");
      expect(joinRes.body.currentMember.color).toBeDefined();
      expect(joinRes.body.currentMember.color).not.toBe(
        joinRes.body.room.members[0].color
      );
    });

    it("enforces PRD ROOM-4 max 6 participants limit", async () => {
      const created = await request(app).post("/api/v1/rooms").send({
        title: "Six Participant Cap Room",
      });
      const slug = created.body.room.slug;

      // Owner is 1st participant. Add 5 more guests (total 6):
      for (let i = 1; i <= 5; i++) {
        // Send unique cookie for each simulated user
        const res = await request(app)
          .post(`/api/v1/rooms/${slug}/join`)
          .set("Cookie", [`pairprep_session=guest_user_${i}`])
          .send({ displayName: `Guest ${i}` });

        expect(res.status).toBe(200);
      }

      // 7th participant attempt must be rejected with 409 ROOM_FULL
      const overflowRes = await request(app)
        .post(`/api/v1/rooms/${slug}/join`)
        .set("Cookie", ["pairprep_session=guest_user_7"])
        .send({ displayName: "Guest 7 (Overflow)" });

      expect(overflowRes.status).toBe(409);
      expect(overflowRes.body.error).toBe("ROOM_FULL");
      expect(overflowRes.body.message).toContain("maximum of 6 participants");
    });
  });

  describe("Role Management & Lifecycle (ROOM-3, ROOM-6)", () => {
    it("allows owner to update participant roles", async () => {
      const ownerCookie = "pairprep_session=owner_user_1";
      const created = await request(app)
        .post("/api/v1/rooms")
        .set("Cookie", [ownerCookie])
        .send({ title: "Role Management Room" });

      const slug = created.body.room.slug;

      // Candidate joins
      const candidateCookie = "pairprep_session=cand_user_2";
      const joined = await request(app)
        .post(`/api/v1/rooms/${slug}/join`)
        .set("Cookie", [candidateCookie])
        .send({ displayName: "Student A" });

      const memberId = joined.body.currentMember.id;

      // Owner promotes candidate to interviewer
      const updateRes = await request(app)
        .patch(`/api/v1/rooms/${slug}/members/${memberId}`)
        .set("Cookie", [ownerCookie])
        .send({ role: "interviewer" });

      expect(updateRes.status).toBe(200);
      const updatedMember = updateRes.body.room.members.find(
        (m: { id: string }) => m.id === memberId
      );
      expect(updatedMember.role).toBe("interviewer");
    });

    it("rejects non-owner attempts to change roles with 403 Forbidden", async () => {
      const created = await request(app)
        .post("/api/v1/rooms")
        .set("Cookie", ["pairprep_session=owner_1"])
        .send({ title: "Security Room" });

      const slug = created.body.room.slug;

      // Normal guest joins
      const joined = await request(app)
        .post(`/api/v1/rooms/${slug}/join`)
        .set("Cookie", ["pairprep_session=intruder_1"])
        .send({ displayName: "Intruder" });

      const memberId = joined.body.currentMember.id;

      // Intruder attempts to promote themselves to owner
      const badRes = await request(app)
        .patch(`/api/v1/rooms/${slug}/members/${memberId}`)
        .set("Cookie", ["pairprep_session=intruder_1"])
        .send({ role: "owner" });

      expect(badRes.status).toBe(403);
      expect(badRes.body.error).toBe("FORBIDDEN");
    });

    it("allows owner to end a room (ROOM-6)", async () => {
      const ownerCookie = "pairprep_session=owner_room_end";
      const created = await request(app)
        .post("/api/v1/rooms")
        .set("Cookie", [ownerCookie])
        .send({ title: "Session Ending Room" });

      const slug = created.body.room.slug;

      const endRes = await request(app)
        .post(`/api/v1/rooms/${slug}/end`)
        .set("Cookie", [ownerCookie]);

      expect(endRes.status).toBe(200);
      expect(endRes.body.room.status).toBe("ended");

      // Joining an ended room is rejected
      const joinEnded = await request(app)
        .post(`/api/v1/rooms/${slug}/join`)
        .set("Cookie", ["pairprep_session=late_guest"])
        .send({ displayName: "Late Guest" });

      expect(joinEnded.status).toBe(403);
      expect(joinEnded.body.error).toBe("ROOM_CLOSED");
    });
  });
});
