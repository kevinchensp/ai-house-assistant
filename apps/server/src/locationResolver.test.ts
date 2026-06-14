import { describe, expect, it, vi } from "vitest";
import { AmapLocationResolver, extractLocationQueryCandidates } from "./locationResolver";

describe("AmapLocationResolver", () => {
  it("resolves a metro station POI to a normalized location", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "1",
        count: "1",
        pois: [
          {
            name: "嘉禾望岗",
            type: "交通设施服务;地铁站;地铁站",
            cityname: "广州市",
            adname: "白云区",
            address: "地铁2号线;地铁3号线北延段;地铁14号线",
            location: "113.289243,23.237460"
          }
        ]
      })
    });
    const resolver = new AmapLocationResolver({ apiKey: "web-service-key", fetchFn: fetchMock });

    await expect(resolver.resolve("嘉禾望岗")).resolves.toMatchObject({
      raw: "嘉禾望岗",
      normalized: "嘉禾望岗",
      city: "广州",
      district: "白云区",
      placeType: "metro_station",
      center: { lng: 113.289243, lat: 23.23746 },
      confidence: 0.9
    });
  });

  it("extracts specific location candidates from a mixed rental request", () => {
    expect(extractLocationQueryCandidates("白云嘉禾望岗一居室 800 左右")).toEqual([
      "嘉禾望岗",
      "白云嘉禾望岗"
    ]);
  });
});
