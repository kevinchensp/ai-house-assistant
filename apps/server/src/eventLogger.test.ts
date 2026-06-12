import { describe, expect, it } from "vitest";
import { InMemoryEventLogger } from "./eventLogger";

describe("InMemoryEventLogger", () => {
  it("records events with session id and timestamp", () => {
    const logger = new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z");

    logger.record("message_sent", { sessionId: "s1", payload: { text: "找东平一室一厅" } });

    expect(logger.all()).toEqual([
      {
        type: "message_sent",
        sessionId: "s1",
        payload: { text: "找东平一室一厅" },
        createdAt: "2026-06-12T00:00:00.000Z"
      }
    ]);
  });
});
