import { describe, expect, it, vi } from "vitest";
import { McpClient } from "./mcpClient";

describe("McpClient", () => {
  it("calls MCP tools with JSON-RPC and bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [] } })
    });

    const client = new McpClient({
      url: "http://mcp.test/mcp",
      authToken: "secret",
      fetchFn: fetchMock
    });

    await client.callTool("search_houses", { pageSize: 3 });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://mcp.test/mcp",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer secret",
          "Content-Type": "application/json"
        }),
        body: expect.stringContaining("\"method\":\"tools/call\"")
      })
    );
  });

  it("falls back to empty images when house detail image table is missing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "The table `house_images` does not exist in the current database." }
      })
    });

    const client = new McpClient({
      url: "http://mcp.test/mcp",
      authToken: "secret",
      fetchFn: fetchMock
    });

    await expect(client.getHouseDetailSafe("1978")).resolves.toEqual({
      houseId: "1978",
      images: [],
      unavailableReason: "house_images table is unavailable"
    });
  });

  it("normalizes coordinates from nested building data", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                rows: [
                  {
                    house_id: "h1",
                    building_id: "b1",
                    building_name: "白云公寓",
                    house_number: "201",
                    rent_price: 1000,
                    deposit: 1000,
                    bedroom: 1,
                    living_room: 1,
                    toilet: 1,
                    area: 35,
                    status: 0,
                    updated_at: "2026-06-13T00:00:00.000Z",
                    building: {
                      address: "白云区东平",
                      lng: "113.293204",
                      lat: "23.225461"
                    }
                  }
                ]
              })
            }
          ]
        }
      })
    });

    const client = new McpClient({
      url: "http://mcp.test/mcp",
      authToken: "secret",
      fetchFn: fetchMock
    });

    await expect(client.searchHouses({ keyword: "东平" })).resolves.toMatchObject([
      {
        houseId: "h1",
        lng: 113.293204,
        lat: 23.225461,
        address: "白云区东平"
      }
    ]);
  });

  it("calls geo search and extracts detail image urls", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  rows: [
                    {
                      house_id: "h2",
                      building_id: "b2",
                      building_name: "附近公寓",
                      house_number: "301",
                      rent_price: 900,
                      deposit: 900,
                      bedroom: 1,
                      living_room: 0,
                      toilet: 1,
                      area: 28,
                      status: 0,
                      updated_at: "2026-06-13T00:00:00.000Z",
                      building: { lng: "113.2558", lat: "23.2036" }
                    }
                  ]
                })
              }
            ]
          }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  house_id: "h2",
                  images: [{ url: "https://img.example.com/h2.jpg" }]
                })
              }
            ]
          }
        })
      });

    const client = new McpClient({
      url: "http://mcp.test/mcp",
      authToken: "secret",
      fetchFn: fetchMock
    });

    await expect(client.searchHousesGeo({ lng: 113.2558, lat: 23.2036 })).resolves.toMatchObject([
      { houseId: "h2", lng: 113.2558, lat: 23.2036 }
    ]);
    await expect(client.getHouseImageUrlsSafe("h2")).resolves.toEqual(["https://img.example.com/h2.jpg"]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://mcp.test/mcp",
      expect.objectContaining({
        body: expect.stringContaining("\"name\":\"search_houses_geo\"")
      })
    );
  });
});
