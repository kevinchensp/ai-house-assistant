import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RankedHouse } from "@ai-house-assistant/shared";
import type { ChatResponse } from "./assistant";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonAppStore } from "./appStore";

describe("JsonAppStore", () => {
  let dir: string;
  let store: JsonAppStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-house-store-"));
    store = new JsonAppStore(join(dir, "store.json"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("isolates customer sessions by owner user", async () => {
    const alice = await store.createUser({ name: "小陈", phone: "13800000001", password: "123456" });
    const bob = await store.createUser({ name: "小李", phone: "13800000002", password: "123456" });
    const aliceSession = await store.createCustomerSession(alice.id, "客户 1");
    await store.createCustomerSession(bob.id, "客户 2");

    await store.addMessage(alice.id, aliceSession.id, "user", "帮我找龙归单间");
    const aliceSessions = await store.listCustomerSessions(alice.id);
    const bobSessions = await store.listCustomerSessions(bob.id);

    expect(aliceSessions).toHaveLength(1);
    expect(aliceSessions[0]?.messages).toMatchObject([{ role: "user", content: "帮我找龙归单间" }]);
    expect(bobSessions).toHaveLength(1);
    expect(bobSessions[0]?.messages).toEqual([]);
  });

  it("rejects writes to sessions owned by another user", async () => {
    const alice = await store.createUser({ name: "小陈", phone: "13800000001", password: "123456" });
    const bob = await store.createUser({ name: "小李", phone: "13800000002", password: "123456" });
    const aliceSession = await store.createCustomerSession(alice.id, "客户 1");

    await expect(store.addMessage(bob.id, aliceSession.id, "user", "越权写入")).rejects.toThrow("not found");
  });

  it("renames customer sessions owned by the user", async () => {
    const alice = await store.createUser({ name: "小陈", phone: "13800000001", password: "123456" });
    const session = await store.createCustomerSession(alice.id, "客户 1");

    const renamed = await store.renameCustomerSession(alice.id, session.id, "张先生");

    expect(renamed.customerName).toBe("张先生");
    await expect(store.renameCustomerSession(alice.id, session.id, " ")).rejects.toThrow("customer name is required");
  });

  it("creates the default admin account once", async () => {
    const firstAdmin = await store.ensureAdminUser();
    const secondAdmin = await store.ensureAdminUser();
    const users = await store.listUsers();

    expect(firstAdmin.id).toBe(secondAdmin.id);
    expect(firstAdmin.phone).toBe("admin");
    expect(firstAdmin.role).toBe("admin");
    expect(users).toHaveLength(1);
  });

  it("stores a paged latest response separately from the full recommendation pool", async () => {
    const agent = await store.createUser({ name: "小陈", phone: "13800000001", password: "123456" });
    const session = await store.createCustomerSession(agent.id, "客户 1");
    const pool = [buildRankedHouse("h1"), buildRankedHouse("h2"), buildRankedHouse("h3")];
    const result = buildChatResponse(pool.slice(0, 2));

    await store.saveAssistantResult(agent.id, session.id, result, "已推荐前 2 套", pool);

    const saved = await store.getCustomerSession(agent.id, session.id);
    expect(saved.latestResponse?.recommendations.map((house) => house.houseId)).toEqual(["h1", "h2"]);
    expect(saved.latestRecommendationPool?.map((house) => house.houseId)).toEqual(["h1", "h2", "h3"]);
  });
});

function buildChatResponse(recommendations: RankedHouse[]): ChatResponse {
  return {
    sessionId: "s1",
    answerMode: "recommend_houses",
    requirement: {
      location: null,
      budget: null,
      layout: { bedroom: null, livingRoom: null, toilet: null, confidence: 0 },
      preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
      missingRequiredSlots: [],
      shouldAskFollowUp: false,
      followUpQuestion: null
    },
    followUpQuestion: null,
    searchTrace: [],
    recommendations,
    consultation: null,
    salesReply: { text: "已推荐房源", nextAction: "copy_reply" }
  };
}

function buildRankedHouse(houseId: string): RankedHouse {
  return {
    houseId,
    buildingId: `b-${houseId}`,
    buildingName: "测试公寓",
    houseNumber: houseId,
    rentPrice: 1000,
    deposit: 1000,
    bedroom: 1,
    livingRoom: 1,
    toilet: 1,
    area: 35,
    direction: "",
    status: 0,
    updatedAt: "2026-06-17T00:00:00.000Z",
    lng: null,
    lat: null,
    score: 100,
    recommendationReason: "匹配需求",
    mismatchNote: null,
    distanceMeters: null
  };
}
