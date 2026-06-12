import { describe, expect, it } from "vitest";
import { createAssistant } from "./assistant";
import { InMemoryEventLogger } from "./eventLogger";

describe("assistant", () => {
  it("returns follow-up when core slots are missing", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async () => []
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z")
    });

    const response = await assistant.chat({
      sessionId: "s1",
      message: "帮我找个房"
    });

    expect(response.followUpQuestion).toContain("区域");
    expect(response.recommendations).toEqual([]);
  });

  it("recommends ranked fallback houses from MCP results", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          if (args.keyword === "东平") return [];
          return [
            {
              houseId: "1978",
              buildingId: "37",
              buildingName: "白心公寓12",
              houseNumber: "110",
              rentPrice: 1000,
              deposit: 1000,
              bedroom: 1,
              livingRoom: 1,
              toilet: 1,
              area: 60,
              direction: "",
              status: 0,
              updatedAt: "2026-06-11T16:21:58.000Z",
              lng: 113.29748,
              lat: 23.222149
            }
          ];
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z")
    });

    const response = await assistant.chat({
      sessionId: "s1",
      message: "帮我找白云东平一室一厅，预算1000左右"
    });

    expect(response.requirement.location?.normalized).toBe("东平");
    expect(response.searchTrace.map((step) => step.name)).toEqual(["strict_keyword", "district_fallback"]);
    expect(response.recommendations[0]).toMatchObject({
      houseId: "1978",
      buildingName: "白心公寓12",
      rentPrice: 1000
    });
    expect(response.salesReply.text).toContain("东平附近暂时没看到完全匹配");
  });

  it("treats one-bedroom phrasing as enough layout information to search", async () => {
    const calls: Record<string, unknown>[] = [];
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          calls.push(args);
          return [];
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z")
    });

    const response = await assistant.chat({
      sessionId: "s1",
      message: "帮我找白云石井800左右的一居室"
    });

    expect(response.followUpQuestion).toBeNull();
    expect(response.requirement.layout.bedroom).toBe(1);
    expect(response.requirement.layout.livingRoom).toBe(0);
    expect(calls[0]).toMatchObject({
      keyword: "石井",
      bedroom: 1,
      livingRoom: 0
    });
  });

  it("prefers model-extracted requirements over rule parsing", async () => {
    const calls: Record<string, unknown>[] = [];
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          calls.push(args);
          return [];
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async () => ({
          location: {
            raw: "石井附近便宜点的一房",
            normalized: "石井",
            city: "广州",
            district: "白云区",
            placeType: "business_area",
            center: { lng: 113.2558, lat: 23.2036 },
            confidence: 0.84
          },
          budget: { target: 900, min: 0, max: 900, confidence: 0.82 },
          layout: { bedroom: 1, livingRoom: null, toilet: null, confidence: 0.8 },
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null },
          missingRequiredSlots: [],
          shouldAskFollowUp: false,
          followUpQuestion: null
        })
      }
    });

    const response = await assistant.chat({
      sessionId: "s1",
      message: "客户在石井附近上班，想找个便宜点的一房"
    });

    expect(response.followUpQuestion).toBeNull();
    expect(response.requirement.budget?.max).toBe(900);
    expect(calls[0]).toMatchObject({
      keyword: "石井",
      bedroom: 1,
      maxRent: 900
    });
  });

  it("falls back to rule parsing when model extraction throws", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async () => []
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async () => {
          throw new Error("model unavailable");
        }
      }
    });

    const response = await assistant.chat({
      sessionId: "s1",
      message: "帮我找白云石井800左右的一居室"
    });

    expect(response.requirement.location?.normalized).toBe("石井");
    expect(response.requirement.budget?.target).toBe(800);
    expect(response.followUpQuestion).toBeNull();
  });
});
