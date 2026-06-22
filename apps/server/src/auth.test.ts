import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonAppStore } from "./appStore";
import { AuthService } from "./auth";

describe("AuthService", () => {
  let dir: string;
  let store: JsonAppStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-house-auth-"));
    store = new JsonAppStore(join(dir, "store.json"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it("expires bearer tokens after the configured ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T00:00:00.000Z"));
    const user = await store.createUser({ name: "小陈", phone: "13800000001", password: "123456" });
    const auth = new AuthService(store, { tokenTtlMs: 1000 });

    const login = await auth.login(user.phone, "123456");

    expect(auth.getUserIdFromAuthorization(`Bearer ${login.token}`)).toBe(user.id);
    vi.setSystemTime(new Date("2026-06-21T00:00:02.000Z"));
    expect(auth.getUserIdFromAuthorization(`Bearer ${login.token}`)).toBeNull();
  });

  it("revokes tokens on logout", async () => {
    const user = await store.createUser({ name: "小陈", phone: "13800000001", password: "123456" });
    const auth = new AuthService(store);
    const login = await auth.login(user.phone, "123456");

    auth.logout(login.token);

    expect(auth.getUserIdFromAuthorization(`Bearer ${login.token}`)).toBeNull();
  });
});
