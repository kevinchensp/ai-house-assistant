import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    const alice = await store.upsertUserByName("小陈");
    const bob = await store.upsertUserByName("小李");
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
    const alice = await store.upsertUserByName("小陈");
    const bob = await store.upsertUserByName("小李");
    const aliceSession = await store.createCustomerSession(alice.id, "客户 1");

    await expect(store.addMessage(bob.id, aliceSession.id, "user", "越权写入")).rejects.toThrow("not found");
  });
});
