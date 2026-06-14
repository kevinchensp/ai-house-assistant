import { describe, expect, test, vi } from "vitest";
import { BailianLlmProvider } from "./bailianLlmProvider";

describe("BailianLlmProvider", () => {
  test("extracts assistant intent for availability consultation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: "area_layout_availability",
                locationKeyword: "花都狮岭",
                layout: { bedroom: 1, livingRoom: null },
                confidence: 0.91
              })
            }
          }
        ]
      })
    });
    const provider = new BailianLlmProvider({
      apiKey: "test-key",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      fetchFn: fetchMock
    });

    await expect(provider.extractAssistantIntent("花都狮岭有没有一房")).resolves.toEqual({
      type: "area_layout_availability",
      locationKeyword: "花都狮岭",
      layout: { bedroom: 1, livingRoom: null },
      confidence: 0.91
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).messages[0].content).toContain("intent");
  });

  test("extracts a structured rental requirement through the compatible chat completion API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                location: {
                  raw: "石井",
                  normalized: "石井",
                  city: "广州",
                  district: "白云区",
                  placeType: "business_area",
                  center: { lng: 113.2558, lat: 23.2036 },
                  confidence: 0.86
                },
                budget: { target: 900, min: 0, max: 900, confidence: 0.9 },
                layout: { bedroom: 1, livingRoom: null, toilet: null, confidence: 0.85 },
                preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: ["近地铁"] },
                missingRequiredSlots: [],
                shouldAskFollowUp: false,
                followUpQuestion: null
              })
            }
          }
        ]
      })
    });

    const provider = new BailianLlmProvider({
      apiKey: "test-key",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      fetchFn: fetchMock
    });

    const requirement = await provider.extractRequirement("客户在石井附近上班，预算别超过九百，想要一房");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json"
        }
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "qwen-plus",
      response_format: { type: "json_object" }
    });
    expect(requirement.budget?.max).toBe(900);
    expect(requirement.location?.normalized).toBe("石井");
    expect(requirement.preferences.features).toEqual(["近地铁"]);
    expect(requirement.shouldAskFollowUp).toBe(false);
  });

  test("throws when Bailian returns invalid JSON so the assistant can fall back", async () => {
    const provider = new BailianLlmProvider({
      apiKey: "test-key",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/",
      model: "qwen-plus",
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "我需要更多信息" } }]
        })
      })
    });

    await expect(provider.extractRequirement("随便看看")).rejects.toThrow("Bailian response was not valid JSON");
  });

  test("repairs low-confidence model output with safe local normalization", async () => {
    const provider = new BailianLlmProvider({
      apiKey: "test-key",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  location: {
                    raw: "客户在石井附近上班，预算别超过九百，想要一房",
                    normalized: "客户在石井附近上班，预算别超过九百，想要一房",
                    city: "广州",
                    district: null,
                    placeType: "unknown",
                    center: null,
                    confidence: 0.2
                  },
                  budget: null,
                  layout: { bedroom: 1, livingRoom: 0, toilet: null, confidence: 0.9 },
                  preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
                  missingRequiredSlots: ["location", "budget"],
                  shouldAskFollowUp: true,
                  followUpQuestion: "请问客户主要想看哪个区域、预算大概多少，以及户型要求是什么？"
                })
              }
            }
          ]
        })
      })
    });

    const requirement = await provider.extractRequirement("客户在石井附近上班，预算别超过九百，想要一房");

    expect(requirement.location?.normalized).toBe("石井");
    expect(requirement.budget?.max).toBe(900);
    expect(requirement.missingRequiredSlots).toEqual([]);
    expect(requirement.shouldAskFollowUp).toBe(false);
  });

  test("accepts partial model JSON and fills required schema defaults before validation", async () => {
    const provider = new BailianLlmProvider({
      apiKey: "test-key",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  location: { raw: "石井", normalized: "石井" },
                  layout: { bedroom: 1 }
                })
              }
            }
          ]
        })
      })
    });

    const requirement = await provider.extractRequirement("石井附近一房，预算九百以内");

    expect(requirement.location?.district).toBe("白云区");
    expect(requirement.budget?.max).toBe(900);
    expect(requirement.layout.bedroom).toBe(1);
  });

  test("prefers local location normalization when model returns a long address", async () => {
    const provider = new BailianLlmProvider({
      apiKey: "test-key",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  location: {
                    raw: "白云石井",
                    normalized: "广州市白云区石井街道",
                    city: "广州",
                    district: "白云区",
                    placeType: "business_area",
                    center: { lng: 113.2558, lat: 23.2036 },
                    confidence: 0.9
                  },
                  budget: { target: 600, min: 500, max: 700, confidence: 0.9 },
                  layout: { bedroom: 1, livingRoom: null, toilet: null, confidence: 0.85 },
                  preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: ["带阳台"] },
                  missingRequiredSlots: [],
                  shouldAskFollowUp: false,
                  followUpQuestion: null
                })
              }
            }
          ]
        })
      })
    });

    const requirement = await provider.extractRequirement("帮我找白云石井一室，预算600左右");

    expect(requirement.location?.normalized).toBe("石井");
  });

  test("fills preference feature chips from user text when model omits them", async () => {
    const provider = new BailianLlmProvider({
      apiKey: "test-key",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  location: { raw: "白云龙归", normalized: "龙归" },
                  budget: { target: 600, min: 500, max: 700, confidence: 0.9 },
                  layout: { bedroom: 1, livingRoom: 0, toilet: null, confidence: 0.85 },
                  preferences: { rentType: null, direction: null, minArea: null, moveInDate: null },
                  missingRequiredSlots: [],
                  shouldAskFollowUp: false,
                  followUpQuestion: null
                })
              }
            }
          ]
        })
      })
    });

    const requirement = await provider.extractRequirement("客户想要白云龙归的大单间，预算600左右，靠近地铁站，最好有阳台");

    expect(requirement.preferences.features).toEqual(["近地铁", "带阳台", "大单间"]);
  });
});
