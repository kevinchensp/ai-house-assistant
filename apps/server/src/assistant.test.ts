import { describe, expect, it } from "vitest";
import { createAssistant } from "./assistant";
import { InMemoryEventLogger } from "./eventLogger";
import { extractRequirementByRules } from "./requirementRules";

describe("assistant", () => {
  it("returns follow-up when core slots are missing", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async () => []
      },
      locationResolver: {
        resolve: async (query) => {
          if (query === "永泰") {
            return {
              raw: "永泰",
              normalized: "永泰",
              city: "广州",
              district: "白云区",
              placeType: "metro_station",
              center: { lng: 113.3069, lat: 23.2202 },
              confidence: 0.9
            };
          }
          if (query === "同和") {
            return {
              raw: "同和",
              normalized: "同和",
              city: "广州",
              district: "白云区",
              placeType: "metro_station",
              center: { lng: 113.326, lat: 23.197 },
              confidence: 0.9
            };
          }
          return null;
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z")
    });

    const response = await assistant.chat({
      sessionId: "s1",
      message: "帮我找个房"
    });

    expect(response.followUpQuestion).toContain("区域");
    expect(response.followUpQuestion).toContain("具体位置");
    expect(response.recommendations).toEqual([]);
  });

  it("asks only for layout when location and budget are already known", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async () => []
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async () => ({
          location: {
            raw: "永泰",
            normalized: "永泰",
            city: "广州",
            district: "白云区",
            placeType: "metro_station",
            center: { lng: 113.3069, lat: 23.2202 },
            confidence: 0.84
          },
          budget: { target: 1000, min: 800, max: 1200, confidence: 0.9 },
          layout: { bedroom: null, livingRoom: null, toilet: null, confidence: 0.2 },
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
          missingRequiredSlots: ["layout"],
          shouldAskFollowUp: true,
          followUpQuestion: "请问客户主要想看哪个区域、预算大概多少，以及户型要求是什么？"
        })
      }
    });

    const response = await assistant.chat({
      sessionId: "s-layout-only",
      message: "我想要找永泰的房子1000左右"
    });

    expect(response.followUpQuestion).toContain("户型");
    expect(response.followUpQuestion).toContain("单间");
    expect(response.followUpQuestion).toContain("一室一厅");
    expect(response.followUpQuestion).not.toContain("区域");
    expect(response.followUpQuestion).not.toContain("预算");
  });

  it("asks for a more specific place when location is only an administrative district", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async () => []
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async () => ({
          location: {
            raw: "白云区",
            normalized: "广州市白云区",
            city: "广州",
            district: "白云区",
            placeType: "unknown",
            center: null,
            confidence: 0.86
          },
          budget: { target: 1000, min: 800, max: 1200, confidence: 0.9 },
          layout: { bedroom: 2, livingRoom: null, toilet: null, confidence: 0.8 },
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
          missingRequiredSlots: [],
          shouldAskFollowUp: false,
          followUpQuestion: null
        })
      }
    });

    const response = await assistant.chat({
      sessionId: "s-district-only",
      message: "帮我找白云的两房，预算1000左右"
    });

    expect(response.requirement.missingRequiredSlots).toEqual(["location"]);
    expect(response.followUpQuestion).toContain("具体位置");
    expect(response.followUpQuestion).toContain("商圈");
    expect(response.followUpQuestion).not.toContain("预算");
    expect(response.followUpQuestion).not.toContain("户型");
    expect(response.searchTrace).toEqual([]);
  });

  it("does not accept a client POI that was inferred from a district-only location", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async () => []
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async () => ({
          location: {
            raw: "黄埔",
            normalized: "广州市黄埔区",
            city: "广州",
            district: "黄埔区",
            placeType: "unknown",
            center: null,
            confidence: 0.86
          },
          budget: null,
          layout: { bedroom: null, livingRoom: null, toilet: null, confidence: 0.2 },
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
          missingRequiredSlots: ["budget", "layout"],
          shouldAskFollowUp: true,
          followUpQuestion: "请确认客户的预算、户型要求。"
        })
      }
    });

    const response = await assistant.chat({
      sessionId: "s-huangpu-company-poi",
      message: "黄埔有什么房源",
      clientResolvedLocation: {
        raw: "黄埔",
        normalized: "广州信实翻译有限公司",
        city: "广州",
        district: "黄埔区",
        placeType: "poi",
        center: { lng: 113.456, lat: 23.166 },
        confidence: 0.78
      }
    });

    expect(response.requirement.location?.normalized).toBe("广州市黄埔区");
    expect(response.requirement.missingRequiredSlots).toEqual(["location", "budget", "layout"]);
    expect(response.followUpQuestion).toContain("具体位置");
    expect(response.searchTrace).toEqual([]);
  });

  it("does not treat a budget-only message as a location even if the model does", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async () => []
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async () => ({
          location: {
            raw: "1000左右",
            normalized: "1000左右",
            city: "广州",
            district: null,
            placeType: "poi",
            center: { lng: 113.3, lat: 23.2 },
            confidence: 0.86
          },
          budget: { target: 1000, min: 800, max: 1200, confidence: 0.9 },
          layout: { bedroom: null, livingRoom: null, toilet: null, confidence: 0.2 },
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
          missingRequiredSlots: ["layout"],
          shouldAskFollowUp: true,
          followUpQuestion: "请确认客户的户型要求。"
        })
      }
    });

    const response = await assistant.chat({
      sessionId: "s-budget-only-location",
      message: "1000左右"
    });

    expect(response.requirement.location).toBeNull();
    expect(response.requirement.budget?.target).toBe(1000);
    expect(response.requirement.missingRequiredSlots).toEqual(["location", "layout"]);
    expect(response.followUpQuestion).toContain("具体位置");
    expect(response.followUpQuestion).toContain("户型");
    expect(response.followUpQuestion).not.toContain("预算");
    expect(response.searchTrace).toEqual([]);
  });

  it("does not accept a client POI for a budget-only message", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async () => []
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async () => ({
          location: null,
          budget: { target: 1000, min: 800, max: 1200, confidence: 0.9 },
          layout: { bedroom: null, livingRoom: null, toilet: null, confidence: 0.2 },
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
          missingRequiredSlots: ["location", "layout"],
          shouldAskFollowUp: true,
          followUpQuestion: "请确认客户的位置和户型要求。"
        })
      }
    });

    const response = await assistant.chat({
      sessionId: "s-budget-only-client-location",
      message: "1000左右",
      clientResolvedLocation: {
        raw: "1000左右",
        normalized: "1000左右",
        city: "广州",
        district: null,
        placeType: "poi",
        center: { lng: 113.3, lat: 23.2 },
        confidence: 0.9
      }
    });

    expect(response.requirement.location).toBeNull();
    expect(response.requirement.budget?.target).toBe(1000);
    expect(response.requirement.missingRequiredSlots).toEqual(["location", "layout"]);
    expect(response.searchTrace).toEqual([]);
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

  it("uses geo fallback and enriches recommendations with cover images", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const mcpClient = {
      searchHouses: async (args: Record<string, unknown>) => {
        calls.push({ tool: "search_houses", args });
        return [];
      },
      searchHousesGeo: async (args: Record<string, unknown>) => {
        calls.push({ tool: "search_houses_geo", args });
        return [
          {
            houseId: "geo-1",
            buildingId: "b-geo",
            buildingName: "石井近地铁公寓",
            houseNumber: "502",
            rentPrice: 950,
            deposit: 950,
            bedroom: 1,
            livingRoom: 0,
            toilet: 1,
            area: 30,
            direction: "",
            status: 0,
            updatedAt: "2026-06-13T00:00:00.000Z",
            lng: 113.2559,
            lat: 23.2037
          }
        ];
      },
      getHouseImageUrlsSafe: async (houseId: string) => {
        calls.push({ tool: "get_house_detail", args: { houseId } });
        return ["https://img.example.com/geo-1.jpg"];
      }
    };
    const assistant = createAssistant({
      mcpClient,
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async () => ({
          location: {
            raw: "白云石井",
            normalized: "石井",
            city: "广州",
            district: "白云区",
            placeType: "business_area",
            center: { lng: 113.2558, lat: 23.2036 },
            confidence: 0.84
          },
          budget: { target: 1000, min: 800, max: 1200, confidence: 0.9 },
          layout: { bedroom: 1, livingRoom: null, toilet: null, confidence: 0.85 },
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
          missingRequiredSlots: [],
          shouldAskFollowUp: false,
          followUpQuestion: null
        })
      }
    });

    const response = await assistant.chat({
      sessionId: "s-geo-images",
      message: "帮我找白云石井一室，预算1000左右"
    });

    expect(response.searchTrace.map((step) => step.name)).toEqual(["strict_keyword", "geo_radius_fallback"]);
    expect(calls[1]).toMatchObject({
      tool: "search_houses_geo",
      args: {
        lng: 113.2558,
        lat: 23.2036,
        radiusMeters: 3000,
        bedroom: 1,
        minRent: 800,
        maxRent: 1200
      }
    });
    expect(response.recommendations[0]).toMatchObject({
      houseId: "geo-1",
      coverImageUrl: "https://img.example.com/geo-1.jpg"
    });
  });

  it("prioritizes image-backed houses in recommendation cards", async () => {
    const imageCalls: string[] = [];
    const houses = Array.from({ length: 35 }, (_, index) => ({
      houseId: `img-${index + 1}`,
      buildingId: `b-img-${index + 1}`,
      buildingName: `东平图片公寓${index + 1}`,
      houseNumber: `${200 + index}`,
      rentPrice: index === 34 ? 950 : 1000,
      deposit: 1000,
      bedroom: 1,
      livingRoom: 1,
      toilet: 1,
      area: index === 34 ? 25 : 40,
      direction: "",
      status: 0,
      updatedAt: "2026-06-17T00:00:00.000Z",
      lng: 113.293204 + index * 0.0001,
      lat: 23.225461
    }));
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async () => houses,
        getHouseImageUrlsSafe: async (houseId: string) => {
          imageCalls.push(houseId);
          return houseId === "img-35" ? ["https://img.example.com/img-35.jpg"] : [];
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async () => ({
          location: {
            raw: "白云东平",
            normalized: "东平",
            city: "广州",
            district: "白云区",
            placeType: "metro_station",
            center: { lng: 113.293204, lat: 23.225461 },
            confidence: 0.9
          },
          budget: { target: 1000, min: 800, max: 1200, confidence: 0.9 },
          layout: { bedroom: 1, livingRoom: 1, toilet: null, confidence: 0.9 },
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
          missingRequiredSlots: [],
          shouldAskFollowUp: false,
          followUpQuestion: null
        })
      }
    });

    const response = await assistant.chat({
      sessionId: "s-image-priority",
      message: "帮我找白云东平一室一厅，预算1000左右"
    });

    expect(imageCalls).toContain("img-35");
    expect(response.recommendations).toHaveLength(35);
    expect(response.recommendations[0]).toMatchObject({
      houseId: "img-35",
      coverImageUrl: "https://img.example.com/img-35.jpg"
    });
  });

  it("resolves model-missing location with a location resolver before searching", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          calls.push({ tool: "search_houses", args });
          return [];
        },
        searchHousesGeo: async (args) => {
          calls.push({ tool: "search_houses_geo", args });
          return [
            {
              houseId: "jiahe-1",
              buildingId: "b-jiahe",
              buildingName: "嘉禾望岗公寓",
              houseNumber: "601",
              rentPrice: 850,
              deposit: 850,
              bedroom: 1,
              livingRoom: 0,
              toilet: 1,
              area: 28,
              direction: "",
              status: 0,
              updatedAt: "2026-06-13T00:00:00.000Z",
              lng: 113.2893,
              lat: 23.2375
            }
          ];
        }
      },
      locationResolver: {
        resolve: async (query) => {
          calls.push({ tool: "resolve_location", args: { query } });
          return query === "嘉禾望岗"
            ? {
                raw: "嘉禾望岗",
                normalized: "嘉禾望岗",
                city: "广州",
                district: "白云区",
                placeType: "metro_station",
                center: { lng: 113.289243, lat: 23.23746 },
                confidence: 0.9
              }
            : null;
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async () => ({
          location: null,
          budget: { target: 800, min: 640, max: 960, confidence: 0.9 },
          layout: { bedroom: 1, livingRoom: 0, toilet: null, confidence: 0.85 },
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
          missingRequiredSlots: ["location"],
          shouldAskFollowUp: true,
          followUpQuestion: "请确认具体位置"
        })
      }
    });

    const response = await assistant.chat({
      sessionId: "s-jiahe",
      message: "白云嘉禾望岗一居室 800 左右"
    });

    expect(response.followUpQuestion).toBeNull();
    expect(response.requirement.location).toMatchObject({
      normalized: "嘉禾望岗",
      center: { lng: 113.289243, lat: 23.23746 }
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        { tool: "resolve_location", args: { query: "嘉禾望岗" } },
        expect.objectContaining({
          tool: "search_houses_geo",
          args: expect.objectContaining({ lng: 113.289243, lat: 23.23746 })
        })
      ])
    );
    expect(response.recommendations[0]).toMatchObject({ houseId: "jiahe-1" });
  });

  it("uses client resolved map location before asking follow-up", async () => {
    const calls: Record<string, unknown>[] = [];
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async () => [],
        searchHousesGeo: async (args) => {
          calls.push(args);
          return [
            {
              houseId: "client-jiahe",
              buildingId: "b-client",
              buildingName: "嘉禾望岗公寓",
              houseNumber: "701",
              rentPrice: 800,
              deposit: 800,
              bedroom: 1,
              livingRoom: 0,
              toilet: 1,
              area: 26,
              direction: "",
              status: 0,
              updatedAt: "2026-06-13T00:00:00.000Z",
              lng: 113.2892,
              lat: 23.2374
            }
          ];
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async () => ({
          location: null,
          budget: { target: 800, min: 640, max: 960, confidence: 0.9 },
          layout: { bedroom: 1, livingRoom: 0, toilet: null, confidence: 0.85 },
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
          missingRequiredSlots: ["location"],
          shouldAskFollowUp: true,
          followUpQuestion: "请确认具体位置"
        })
      }
    });

    const response = await assistant.chat({
      sessionId: "s-client-location",
      message: "白云嘉禾望岗一居室 800 左右",
      clientResolvedLocation: {
        raw: "嘉禾望岗",
        normalized: "嘉禾望岗",
        city: "广州",
        district: "白云区",
        placeType: "metro_station",
        center: { lng: 113.289243, lat: 23.23746 },
        confidence: 0.88
      }
    });

    expect(response.followUpQuestion).toBeNull();
    expect(response.requirement.location?.normalized).toBe("嘉禾望岗");
    expect(calls[0]).toMatchObject({
      lng: 113.289243,
      lat: 23.23746
    });
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
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
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

  it("keeps session requirement context when user accepts nearby fallback", async () => {
    const calls: Record<string, unknown>[] = [];
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          calls.push(args);
          if (args.keyword === "白云" && args.maxRent === 960) {
            return [
              {
                houseId: "nearby",
                buildingId: "b1",
                buildingName: "周边公寓",
                houseNumber: "201",
                rentPrice: 1000,
                deposit: 1000,
                bedroom: 1,
                livingRoom: 0,
                toilet: 1,
                area: 35,
                direction: "",
                status: 0,
                updatedAt: "2026-06-12T00:00:00.000Z",
                lng: 113.2558,
                lat: 23.2036
              }
            ];
          }
          return [];
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z")
    });

    await assistant.chat({
      sessionId: "thread-1",
      message: "帮我找白云石井一室，预算800左右"
    });
    const response = await assistant.chat({
      sessionId: "thread-1",
      message: "周边可以"
    });

    expect(response.followUpQuestion).toBeNull();
    expect(response.requirement.location?.normalized).toBe("石井");
    expect(response.requirement.budget?.max).toBe(960);
    expect(response.recommendations[0]).toMatchObject({
      houseId: "nearby",
      buildingName: "周边公寓"
    });
  });

  it("adds pet preference to the existing requirement instead of treating it as nearby acceptance", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async () => {
          return [buildTestHouse("pet-1", 1000, "东平宠物友好公寓", 113.35, 23.27)];
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async (message) => {
          if (message.includes("宠物")) {
            return {
              location: null,
              budget: null,
              layout: { bedroom: null, livingRoom: null, toilet: null, confidence: 0.1 },
              preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
              missingRequiredSlots: ["location", "budget", "layout"],
              shouldAskFollowUp: true,
              followUpQuestion: "请问客户主要想看哪个区域、预算大概多少，以及户型要求是什么？"
            };
          }
          return {
            location: {
              raw: "东平",
              normalized: "东平",
              city: "广州",
              district: "白云区",
              placeType: "metro_station",
              center: { lng: 113.35, lat: 23.27 },
              confidence: 0.9
            },
            budget: { target: 1000, min: 800, max: 1200, confidence: 0.9 },
            layout: { bedroom: 1, livingRoom: 1, toilet: null, confidence: 0.9 },
            preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
            missingRequiredSlots: [],
            shouldAskFollowUp: false,
            followUpQuestion: null
          };
        }
      }
    });

    await assistant.chat({
      sessionId: "thread-pet",
      message: "白云东平一室一厅，预算1000左右"
    });
    const response = await assistant.chat({
      sessionId: "thread-pet",
      message: "可以养宠物"
    });

    expect(response.followUpQuestion).toBeNull();
    expect(response.requirement.location?.normalized).toBe("东平");
    expect(response.requirement.budget?.target).toBe(1000);
    expect(response.requirement.layout).toMatchObject({ bedroom: 1, livingRoom: 1 });
    expect(response.requirement.preferences.features).toContain("可养宠物");
  });

  it("keeps prior location when the model mistakes a pet preference for a location", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async () => {
          return [buildTestHouse("pet-location-1", 1000, "东平宠物友好公寓", 113.35, 23.27)];
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async (message) => {
          if (message.includes("宠物")) {
            return {
              location: {
                raw: "可以养宠物",
                normalized: "可以养宠物",
                city: "广州",
                district: null,
                placeType: "poi",
                center: { lng: 113.2, lat: 23.1 },
                confidence: 0.8
              },
              budget: null,
              layout: { bedroom: null, livingRoom: null, toilet: null, confidence: 0.1 },
              preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
              missingRequiredSlots: ["budget", "layout"],
              shouldAskFollowUp: true,
              followUpQuestion: "请问客户主要想看哪个区域、预算大概多少，以及户型要求是什么？"
            };
          }
          return {
            location: {
              raw: "东平",
              normalized: "东平",
              city: "广州",
              district: "白云区",
              placeType: "metro_station",
              center: { lng: 113.35, lat: 23.27 },
              confidence: 0.9
            },
            budget: { target: 1000, min: 800, max: 1200, confidence: 0.9 },
            layout: { bedroom: 1, livingRoom: 1, toilet: null, confidence: 0.9 },
            preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
            missingRequiredSlots: [],
            shouldAskFollowUp: false,
            followUpQuestion: null
          };
        }
      }
    });

    await assistant.chat({
      sessionId: "thread-pet-location",
      message: "白云东平一室一厅，预算1000左右"
    });
    const response = await assistant.chat({
      sessionId: "thread-pet-location",
      message: "可以养宠物"
    });

    expect(response.requirement.location?.normalized).toBe("东平");
    expect(response.requirement.preferences.features).toContain("可养宠物");
  });

  it("automatically widens budget fallback before asking the customer to compromise", async () => {
    const calls: Record<string, unknown>[] = [];
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          calls.push(args);
          if (args.keyword === "白云" && Number(args.maxRent) >= 1000) {
            return [
              {
                houseId: "over-budget",
                buildingId: "b2",
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
                updatedAt: "2026-06-12T00:00:00.000Z",
                lng: 113.2558,
                lat: 23.2036
              }
            ];
          }
          return [];
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async () => ({
          location: {
            raw: "白云石井",
            normalized: "石井",
            city: "广州",
            district: "白云区",
            placeType: "business_area",
            center: { lng: 113.2558, lat: 23.2036 },
            confidence: 0.84
          },
          budget: { target: 600, min: 500, max: 700, confidence: 0.9 },
          layout: { bedroom: 1, livingRoom: null, toilet: null, confidence: 0.85 },
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
          missingRequiredSlots: [],
          shouldAskFollowUp: false,
          followUpQuestion: null
        })
      }
    });

    const response = await assistant.chat({
      sessionId: "s-budget-expand",
      message: "帮我找白云石井一室，预算600左右"
    });

    expect(response.followUpQuestion).toBeNull();
    expect(response.searchTrace.map((step) => step.name)).toContain("budget_expanded_fallback");
    expect(calls.at(-1)).toMatchObject({
      keyword: "白云",
      maxRent: 1000
    });
    expect(response.recommendations[0]).toMatchObject({
      houseId: "over-budget",
      mismatchNote: "租金不在客户预算区间内"
    });
  });

  it("uses inventory fallback without keyword when keyword fallbacks return no houses", async () => {
    const calls: Record<string, unknown>[] = [];
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          calls.push(args);
          if (args.keyword === undefined && Number(args.maxRent) >= 1000) {
            return [
              {
                houseId: "inventory-nearby",
                buildingId: "b3",
                buildingName: "共生公寓02店A栋",
                houseNumber: "101",
                rentPrice: 1000,
                deposit: 1000,
                bedroom: 1,
                livingRoom: 1,
                toilet: 1,
                area: 40,
                direction: "",
                status: 0,
                updatedAt: "2026-06-12T00:00:00.000Z",
                lng: 113.2558,
                lat: 23.2036
              }
            ];
          }
          return [];
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async () => ({
          location: {
            raw: "白云石井",
            normalized: "石井",
            city: "广州",
            district: "白云区",
            placeType: "business_area",
            center: { lng: 113.2558, lat: 23.2036 },
            confidence: 0.84
          },
          budget: { target: 600, min: 500, max: 700, confidence: 0.9 },
          layout: { bedroom: 1, livingRoom: null, toilet: null, confidence: 0.85 },
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
          missingRequiredSlots: [],
          shouldAskFollowUp: false,
          followUpQuestion: null
        })
      }
    });

    const response = await assistant.chat({
      sessionId: "s-inventory-expand",
      message: "帮我找白云石井一室，预算600左右"
    });

    expect(response.searchTrace.map((step) => step.name)).toContain("inventory_budget_fallback");
    expect(calls.at(-1)).toMatchObject({
      bedroom: 1,
      maxRent: 1000
    });
    expect(calls.at(-1)).not.toHaveProperty("keyword");
    expect(response.recommendations[0]).toMatchObject({
      houseId: "inventory-nearby",
      buildingName: "共生公寓02店A栋"
    });
  });

  it("does not recommend cross-city or coordinate-missing houses for a specific location", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          if (args.keyword !== undefined || Number(args.maxRent) < 1000) return [];
          return [
            {
              houseId: "dongguan-no-coordinate",
              buildingId: "dg1",
              buildingName: "同庆09店大旺二期A栋",
              houseNumber: "415",
              rentPrice: 600,
              deposit: 2100,
              bedroom: 1,
              livingRoom: 1,
              toilet: 1,
              area: 45,
              direction: "",
              status: 0,
              updatedAt: "2026-06-12T00:00:00.000Z",
              address: "肇庆高新区沙沥工业园交德四街10号",
              lng: null,
              lat: null
            },
            {
              houseId: "huizhou-far",
              buildingId: "hz1",
              buildingName: "惠丰70店新城市场A栋",
              houseNumber: "207",
              rentPrice: 600,
              deposit: 1200,
              bedroom: 1,
              livingRoom: 1,
              toilet: 1,
              area: 46,
              direction: "",
              status: 0,
              updatedAt: "2026-06-12T00:00:00.000Z",
              address: "惠康中路23号",
              lng: 114.4126,
              lat: 23.1115
            },
            {
              houseId: "science-city-nearby",
              buildingId: "gz1",
              buildingName: "科学城公寓",
              houseNumber: "101",
              rentPrice: 800,
              deposit: 1600,
              bedroom: 1,
              livingRoom: 0,
              toilet: 1,
              area: 32,
              direction: "",
              status: 0,
              updatedAt: "2026-06-12T00:00:00.000Z",
              address: "广州市黄埔区科学城",
              lng: 113.455,
              lat: 23.165
            }
          ];
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async () => ({
          location: {
            raw: "黄埔科学城",
            normalized: "科学城中心(建设中)",
            city: "广州",
            district: "黄埔区",
            placeType: "metro_station",
            center: { lng: 113.459, lat: 23.167 },
            confidence: 0.86
          },
          budget: { target: 800, min: 600, max: 1000, confidence: 0.9 },
          layout: { bedroom: 1, livingRoom: null, toilet: null, confidence: 0.85 },
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
          missingRequiredSlots: [],
          shouldAskFollowUp: false,
          followUpQuestion: null
        })
      }
    });

    const response = await assistant.chat({
      sessionId: "s-science-city-cross-city",
      message: "黄埔科学城一居室 800"
    });

    expect(response.searchTrace.map((step) => step.name)).toContain("inventory_budget_fallback");
    expect(response.recommendations.map((house) => house.houseId)).toEqual(["science-city-nearby"]);
    expect(response.recommendations[0]?.distanceMeters).toBeGreaterThan(0);
  });

  it("answers project vacancy consultation with available houses", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          expect(args).toMatchObject({ keyword: "龙湖31店", status: 0 });
          return [
            {
              houseId: "lh-1",
              buildingId: "lh",
              buildingName: "龙湖31店下沐A栋",
              houseNumber: "A711",
              rentPrice: 600,
              deposit: 1200,
              bedroom: 1,
              livingRoom: 0,
              toilet: 1,
              area: 25,
              direction: "",
              status: 0,
              updatedAt: "2026-06-12T00:00:00.000Z",
              address: "下沐社区富民路16号",
              lng: 113.459,
              lat: 23.167
            }
          ];
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z")
    });

    const response = await assistant.chat({
      sessionId: "s-project-vacancy",
      message: "龙湖31店还有什么空房？"
    });

    expect(response.answerMode).toBe("project_vacancy");
    expect(response.consultation?.title).toContain("龙湖31店");
    expect(response.recommendations).toHaveLength(1);
    expect(response.salesReply.text).toContain("龙湖31店目前查到 1 套空房");
  });

  it("keeps prior requirement summary when answering consultation questions", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          if (args.keyword === "龙湖31店") {
            return [buildTestHouse("project-1", 980, "龙湖31店", 113.3, 23.22)];
          }
          return [buildTestHouse("recommend-1", 1000, "永泰公寓", 113.306, 23.221)];
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractRequirement: async () => ({
          location: {
            raw: "永泰",
            normalized: "永泰",
            city: "广州",
            district: "白云区",
            placeType: "metro_station",
            center: { lng: 113.3069, lat: 23.2202 },
            confidence: 0.9
          },
          budget: { target: 1000, min: 800, max: 1200, confidence: 0.9 },
          layout: { bedroom: 1, livingRoom: null, toilet: null, confidence: 0.9 },
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
          missingRequiredSlots: [],
          shouldAskFollowUp: false,
          followUpQuestion: null
        })
      }
    });

    await assistant.chat({
      sessionId: "s-consultation-summary-overlay",
      message: "永泰一房，预算1000左右"
    });
    const response = await assistant.chat({
      sessionId: "s-consultation-summary-overlay",
      message: "龙湖31店还有什么空房"
    });

    expect(response.answerMode).toBe("project_vacancy");
    expect(response.requirement.location?.normalized).toBe("永泰");
    expect(response.requirement.budget?.target).toBe(1000);
    expect(response.requirement.layout.bedroom).toBe(1);
  });

  it("answers area inventory consultation without requiring budget or layout", async () => {
    const imageCalls: string[] = [];
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          expect(args).toMatchObject({ keyword: "永泰", status: 0 });
          expect(args).not.toHaveProperty("bedroom");
          return [
            buildTestHouse("yt-room", 780, "永泰单间公寓", 113.306, 23.221),
            buildTestHouse("yt-one", 1050, "永泰一房公寓", 113.307, 23.222),
            buildTestHouse("yt-two", 1500, "永泰两房公寓", 113.308, 23.223)
          ];
        },
        getHouseImageUrlsSafe: async (houseId: string) => {
          imageCalls.push(houseId);
          return houseId === "yt-one" ? ["https://img.example.com/yt-one.jpg"] : [];
        }
      },
      locationResolver: {
        resolve: async (query) =>
          query === "永泰"
            ? {
                raw: "永泰",
                normalized: "永泰",
                city: "广州",
                district: "白云区",
                placeType: "metro_station",
                center: { lng: 113.3069, lat: 23.2202 },
                confidence: 0.9
              }
            : null
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z")
    });

    const response = await assistant.chat({
      sessionId: "s-area-inventory",
      message: "永泰有什么房子"
    });

    expect(response.answerMode).toBe("area_inventory");
    expect(response.followUpQuestion).toBeNull();
    expect(response.consultation?.summary).toContain("永泰目前查到 3 套空房");
    expect(response.recommendations).toHaveLength(3);
    expect(imageCalls).toEqual(["yt-room", "yt-one", "yt-two"]);
    expect(response.recommendations.find((house) => house.houseId === "yt-one")?.coverImageUrl).toBe("https://img.example.com/yt-one.jpg");
    expect(response.salesReply.text).toContain("永泰目前有 3 套空房");
    expect(response.salesReply.text).toContain("您可以看下这几套");
    expect(response.salesReply.text).not.toContain("我可以");
    expect(response.salesReply.text).not.toContain("可先按预算、户型继续筛选");
  });

  it("normalizes area inventory location into the requirement summary", async () => {
    const searchedKeywords: string[] = [];
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          searchedKeywords.push(String(args.keyword));
          return [];
        }
      },
      llmProvider: {
        extractRequirement: async () => extractRequirementByRules("白云永泰"),
        extractAssistantIntent: async () => ({
          type: "area_inventory",
          locationKeyword: "白云永泰",
          confidence: 0.92
        })
      },
      locationResolver: {
        resolve: async (query) =>
          query === "永泰"
            ? {
                raw: "永泰",
                normalized: "永泰",
                city: "广州",
                district: "白云区",
                placeType: "metro_station",
                center: { lng: 113.3069, lat: 23.2202 },
                confidence: 0.9
              }
            : null
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z")
    });

    const response = await assistant.chat({
      sessionId: "s-area-inventory-location-summary",
      message: "白云永泰"
    });

    expect(response.answerMode).toBe("area_inventory");
    expect(searchedKeywords).toEqual(["永泰"]);
    expect(response.requirement.location?.normalized).toBe("永泰");
    expect(response.requirement.location?.center).toEqual({ lng: 113.3069, lat: 23.2202 });
    expect(response.requirement.missingRequiredSlots).toEqual(["budget", "layout"]);
  });

  it("answers metro line inventory by searching line stations", async () => {
    const searchedKeywords: string[] = [];
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          searchedKeywords.push(String(args.keyword));
          if (args.keyword === "永泰") {
            return [buildTestHouse("line-yt", 1200, "永泰沿线公寓", 113.306, 23.221)];
          }
          if (args.keyword === "同和") {
            return [buildTestHouse("line-th", 1300, "同和沿线公寓", 113.326, 23.197)];
          }
          return [];
        }
      },
      locationResolver: {
        resolve: async (query) => {
          if (query === "永泰") {
            return {
              raw: "永泰",
              normalized: "永泰",
              city: "广州",
              district: "白云区",
              placeType: "metro_station",
              center: { lng: 113.3069, lat: 23.2202 },
              confidence: 0.9
            };
          }
          if (query === "同和") {
            return {
              raw: "同和",
              normalized: "同和",
              city: "广州",
              district: "白云区",
              placeType: "metro_station",
              center: { lng: 113.326, lat: 23.197 },
              confidence: 0.9
            };
          }
          return null;
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z")
    });

    const response = await assistant.chat({
      sessionId: "s-metro-line-inventory",
      message: "3号线沿途的房源"
    });

    expect(response.answerMode).toBe("metro_line_inventory");
    expect(searchedKeywords).toContain("永泰");
    expect(searchedKeywords).toContain("同和");
    expect(searchedKeywords).not.toEqual(["3号线"]);
    expect(response.consultation?.summary).toContain("3号线沿线目前查到 2 套空房");
    expect(response.recommendations[0]?.recommendationReason).toContain("靠近");
    expect(response.recommendations[0]?.recommendationReason).toMatch(/约\d+米|约\d+\.\d公里/);
    expect(response.salesReply.text).toContain("3号线沿线目前有 2 套空房");
    expect(response.salesReply.text).toContain("靠近");
    expect(response.salesReply.text).toContain("您可以看下这几套");
    expect(response.salesReply.text).not.toContain("右侧");
  });

  it("answers specific metro station inventory without scanning the whole line", async () => {
    const searchedKeywords: string[] = [];
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          searchedKeywords.push(String(args.keyword));
          if (args.keyword === "同和") {
            return [
              buildTestHouse("th-near", 1000, "同和站旁公寓", 113.3261, 23.1971),
              buildTestHouse("th-far", 900, "同和远一点公寓", 113.33, 23.2)
            ];
          }
          return [];
        }
      },
      locationResolver: {
        resolve: async (query) =>
          query === "同和"
            ? {
                raw: "同和",
                normalized: "同和",
                city: "广州",
                district: "白云区",
                placeType: "metro_station",
                center: { lng: 113.326, lat: 23.197 },
                confidence: 0.9
              }
            : null
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z")
    });

    const response = await assistant.chat({
      sessionId: "s-metro-station-inventory",
      message: "3号线同和站房源"
    });

    expect(response.answerMode).toBe("metro_station_inventory");
    expect(searchedKeywords).toEqual(["同和"]);
    expect(response.recommendations.map((house) => house.houseId)).toEqual(["th-near", "th-far"]);
    expect(response.recommendations[0]?.recommendationReason).toContain("靠近同和站");
    expect(response.salesReply.text).toContain("同和站附近目前有 2 套空房");
  });

  it("answers area layout price range consultation", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          expect(args).toMatchObject({ keyword: "永泰", bedroom: 1, status: 0 });
          return [
            buildTestHouse("yt-1", 780, "永泰公寓", 113.305, 23.226),
            buildTestHouse("yt-2", 950, "永泰公寓", 113.306, 23.227),
            buildTestHouse("yt-3", 1200, "永泰公寓", 113.307, 23.228)
          ];
        }
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z")
    });

    const response = await assistant.chat({
      sessionId: "s-price-range",
      message: "白云永泰一居室的价格范围"
    });

    expect(response.answerMode).toBe("price_range");
    expect(response.consultation?.metrics).toEqual(
      expect.arrayContaining([
        { label: "最低价", value: "780元" },
        { label: "最高价", value: "1200元" },
        { label: "样本数", value: "3套" }
      ])
    );
    expect(response.salesReply.text).toContain("永泰一居室");
    expect(response.salesReply.text).toContain("780-1200元");
  });

  it("answers distance ranking consultation for nearest metro houses", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHousesGeo: async (args) => {
          expect(args).toMatchObject({ lng: 113.293204, lat: 23.225461, status: 0 });
          return [
            buildTestHouse("far", 1000, "远一点公寓", 113.303, 23.235),
            buildTestHouse("near", 900, "近地铁公寓", 113.294, 23.226)
          ];
        },
        searchHouses: async () => []
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z")
    });

    const response = await assistant.chat({
      sessionId: "s-distance-ranking",
      message: "白云东平离地铁最近的房源排序"
    });

    expect(response.answerMode).toBe("distance_ranking");
    expect(response.recommendations.map((house) => house.houseId)).toEqual(["near", "far"]);
    expect(response.salesReply.text).toContain("按距离东平由近到远");
  });

  it("uses model intent to answer area layout availability without requiring budget", async () => {
    const assistant = createAssistant({
      mcpClient: {
        searchHouses: async (args) => {
          expect(args).toMatchObject({ keyword: "花都狮岭", bedroom: 1, status: 0 });
          return [
            buildTestHouse("sl-far", 850, "狮岭合成公寓", 113.19, 23.46),
            buildTestHouse("sl-near", 980, "狮岭市场公寓", 113.1805, 23.4505)
          ];
        }
      },
      locationResolver: {
        resolve: async (query) =>
          query === "花都狮岭"
            ? {
                raw: "花都狮岭",
                normalized: "狮岭",
                city: "广州",
                district: "花都区",
                placeType: "business_area",
                center: { lng: 113.18, lat: 23.45 },
                confidence: 0.88
              }
            : null
      },
      eventLogger: new InMemoryEventLogger(() => "2026-06-12T00:00:00.000Z"),
      llmProvider: {
        extractAssistantIntent: async () => ({
          type: "area_layout_availability",
          locationKeyword: "花都狮岭",
          layout: { bedroom: 1, livingRoom: null },
          confidence: 0.9
        }),
        extractRequirement: async () => {
          throw new Error("should not require recommendation slots for availability consultation");
        }
      }
    });

    const response = await assistant.chat({
      sessionId: "s-area-layout-availability",
      message: "花都狮岭有没有一房"
    });

    expect(response.answerMode).toBe("area_layout_availability");
    expect(response.followUpQuestion).toBeNull();
    expect(response.consultation?.summary).toContain("花都狮岭一居室目前查到 2 套空房");
    expect(response.recommendations.map((house) => house.houseId)).toEqual(["sl-near", "sl-far"]);
    expect(response.recommendations[0]?.distanceMeters).toBeGreaterThan(0);
    expect(response.salesReply.text).toContain("花都狮岭一居室目前有 2 套空房");
  });

  it("omits null optional filters before calling MCP", async () => {
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
            raw: "白云石井",
            normalized: "石井",
            city: "广州",
            district: "白云区",
            placeType: "business_area",
            center: { lng: 113.2558, lat: 23.2036 },
            confidence: 0.84
          },
          budget: { target: 600, min: 500, max: 700, confidence: 0.9 },
          layout: { bedroom: 1, livingRoom: null, toilet: null, confidence: 0.85 },
          preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
          missingRequiredSlots: [],
          shouldAskFollowUp: false,
          followUpQuestion: null
        })
      }
    });

    await assistant.chat({
      sessionId: "s-null-filters",
      message: "帮我找白云石井一室，预算600左右"
    });

    expect(calls[0]).toMatchObject({
      keyword: "石井",
      bedroom: 1
    });
    expect(calls[0]).not.toHaveProperty("livingRoom");
  });
});

function buildTestHouse(houseId: string, rentPrice: number, buildingName: string, lng: number, lat: number) {
  return {
    houseId,
    buildingId: `${houseId}-building`,
    buildingName,
    houseNumber: "101",
    rentPrice,
    deposit: rentPrice * 2,
    bedroom: 1,
    livingRoom: 0,
    toilet: 1,
    area: 30,
    direction: "",
    status: 0,
    updatedAt: "2026-06-12T00:00:00.000Z",
    lng,
    lat
  };
}
