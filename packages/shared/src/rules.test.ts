import { describe, expect, it } from "vitest";
import {
  SearchPlanSchema,
  distanceMeters,
  parseBudgetAround,
  rankHouses,
  resolveLocation,
  validateRequirementExtraction
} from "./index";

describe("parseBudgetAround", () => {
  it("expands a around budget into the default 20 percent range", () => {
    expect(parseBudgetAround("预算1000左右")).toEqual({
      target: 1000,
      min: 800,
      max: 1200,
      confidence: 0.9
    });
  });

  it("returns null when no budget is present", () => {
    expect(parseBudgetAround("想找东平附近一室一厅")).toBeNull();
  });
});

describe("resolveLocation", () => {
  it("resolves high-frequency Guangzhou place names", () => {
    expect(resolveLocation("白云东平")).toMatchObject({
      raw: "白云东平",
      normalized: "东平",
      city: "广州",
      district: "白云区",
      placeType: "metro_station",
      confidence: 0.88
    });

    expect(resolveLocation("白云龙归")).toMatchObject({
      normalized: "龙归",
      district: "白云区",
      placeType: "metro_station"
    });
  });

  it("marks unknown locations as uncertain instead of guessing coordinates", () => {
    const result = resolveLocation("火星东平");

    expect(result.confidence).toBeLessThan(0.5);
    expect(result.center).toBeNull();
  });
});

describe("distanceMeters", () => {
  it("computes distance between two nearby coordinates", () => {
    const distance = distanceMeters(
      { lng: 113.293204, lat: 23.225461 },
      { lng: 113.29748, lat: 23.222149 }
    );

    expect(distance).toBeGreaterThan(500);
    expect(distance).toBeLessThan(700);
  });
});

describe("validateRequirementExtraction", () => {
  it("validates structured model output and preserves missing slots", () => {
    const result = validateRequirementExtraction({
      location: resolveLocation("白云东平"),
      budget: parseBudgetAround("1000左右"),
      layout: { bedroom: 1, livingRoom: 1, toilet: null, confidence: 0.95 },
      preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: ["近地铁"] },
      missingRequiredSlots: [],
      shouldAskFollowUp: false,
      followUpQuestion: null
    });

    expect(result.shouldAskFollowUp).toBe(false);
    expect(result.layout.bedroom).toBe(1);
    expect(result.preferences.features).toEqual(["近地铁"]);
  });
});

describe("SearchPlanSchema", () => {
  it("accepts whitelisted MCP search steps and limits tool calls", () => {
    const plan = SearchPlanSchema.parse({
      steps: [
        {
          name: "strict_keyword",
          tool: "search_houses",
          arguments: { keyword: "东平", pageSize: 20 },
          fallbackReason: null
        }
      ],
      maxToolCalls: 5,
      stopWhenResultsAtLeast: 3
    });

    expect(plan.steps[0]?.tool).toBe("search_houses");
  });
});

describe("rankHouses", () => {
  it("ranks houses by vacancy, budget fit, layout fit, and distance", () => {
    const ranked = rankHouses(
      [
        {
          houseId: "far",
          buildingId: "b1",
          buildingName: "远方公寓",
          houseNumber: "101",
          rentPrice: 1000,
          deposit: 1000,
          bedroom: 1,
          livingRoom: 1,
          toilet: 1,
          area: 45,
          direction: "",
          status: 0,
          updatedAt: "2026-06-01T00:00:00.000Z",
          lng: 113.36,
          lat: 23.28
        },
        {
          houseId: "near",
          buildingId: "b2",
          buildingName: "近处公寓",
          houseNumber: "102",
          rentPrice: 1000,
          deposit: 1000,
          bedroom: 1,
          livingRoom: 1,
          toilet: 1,
          area: 60,
          direction: "",
          status: 0,
          updatedAt: "2026-06-02T00:00:00.000Z",
          lng: 113.293204,
          lat: 23.225461
        }
      ],
      {
        budget: { target: 1000, min: 800, max: 1200, confidence: 0.9 },
        layout: { bedroom: 1, livingRoom: 1, toilet: null, confidence: 0.95 },
        center: { lng: 113.293204, lat: 23.225461 }
      }
    );

    expect(ranked[0]).toMatchObject({
      houseId: "near",
      recommendationReason: expect.stringContaining("租金贴近预算")
    });
    expect(ranked[0]?.distanceMeters).toBe(0);
  });
});
