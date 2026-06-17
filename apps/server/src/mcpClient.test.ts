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
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream"
        }),
        body: expect.stringContaining("\"method\":\"tools/call\"")
      })
    );
  });

  it("parses MCP SDK text event-stream JSON-RPC responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
      text: async () => [
        "event: message",
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  rows: [
                    {
                      house_id: "h-sse",
                      building_id: "b-sse",
                      building_name: "SSE 公寓",
                      house_number: "201",
                      rent_price: 900,
                      deposit: 900,
                      bedroom: 1,
                      living_room: 0,
                      toilet: 1,
                      area: 28,
                      status: 0,
                      updated_at: "2026-06-17T00:00:00.000Z",
                      building: { address: "东平", lng: "113.293204", lat: "23.225461" }
                    }
                  ]
                })
              }
            ]
          }
        })}`,
        ""
      ].join("\n")
    });

    const client = new McpClient({
      url: "http://mcp.test/mcp",
      authToken: "secret",
      fetchFn: fetchMock
    });

    await expect(client.searchHouses({ keyword: "东平" })).resolves.toMatchObject([
      {
        houseId: "h-sse",
        rentPrice: 900,
        lng: 113.293204,
        lat: 23.225461
      }
    ]);
  });

  it("fetches multiple paginated MCP pages up to maxResults", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildRowsResponse(buildMcpRows(1, 50), {
        page: 1,
        pageSize: 50,
        total: 75,
        totalPages: 2,
        hasNext: true
      }))
      .mockResolvedValueOnce(buildRowsResponse(buildMcpRows(51, 25), {
        page: 2,
        pageSize: 50,
        total: 75,
        totalPages: 2,
        hasNext: false
      }));

    const client = new McpClient({
      url: "http://mcp.test/mcp",
      authToken: "secret",
      fetchFn: fetchMock
    });

    await expect(client.searchHouses({ keyword: "东平", pageSize: 50, maxResults: 75 })).resolves.toHaveLength(75);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).params.arguments).toMatchObject({
      keyword: "东平",
      page: 1,
      pageSize: 50
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).params.arguments).toMatchObject({
      keyword: "东平",
      page: 2,
      pageSize: 50
    });
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

  it("swaps reversed building coordinates before ranking uses them", async () => {
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
                    house_id: "h-reversed",
                    building_id: "b-reversed",
                    building_name: "泰竣36东平九期A栋",
                    house_number: "1002",
                    rent_price: 1,
                    deposit: 0,
                    bedroom: 1,
                    living_room: 0,
                    toilet: 1,
                    area: 35,
                    status: 0,
                    updated_at: "2026-06-13T00:00:00.000Z",
                    building: {
                      address: "东平九期A栋",
                      lng: "22.940397",
                      lat: "113.400876"
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
        houseId: "h-reversed",
        lng: 113.400876,
        lat: 22.940397
      }
    ]);
  });

  it("drops invalid building coordinates instead of producing impossible distances", async () => {
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
                    house_id: "h-invalid",
                    building_id: "b-invalid",
                    building_name: "异常坐标楼栋",
                    house_number: "1002",
                    rent_price: 800,
                    deposit: 0,
                    bedroom: 1,
                    living_room: 0,
                    toilet: 1,
                    area: 35,
                    status: 0,
                    updated_at: "2026-06-13T00:00:00.000Z",
                    building: {
                      address: "异常地址",
                      lng: "999",
                      lat: "999"
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
        houseId: "h-invalid",
        lng: null,
        lat: null
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

  it("normalizes relative detail image urls to the Manzu image host", async () => {
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
                house_id: "h-relative-image",
                images: [
                  {
                    image_url: "/storage/images/202503/19/room.jpg",
                    prefix: ""
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

    await expect(client.getHouseImageUrlsSafe("h-relative-image")).resolves.toEqual([
      "https://image.manzu365.com/storage/images/202503/19/room.jpg"
    ]);
  });
});

function buildRowsResponse(
  rows: unknown[],
  pagination: { page: number; pageSize: number; total: number; totalPages: number; hasNext: boolean }
) {
  return {
    ok: true,
    json: async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ rows, pagination })
          }
        ]
      }
    })
  };
}

function buildMcpRows(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const id = start + index;
    return {
      house_id: `h-page-${id}`,
      building_id: `b-page-${id}`,
      building_name: "分页公寓",
      house_number: String(id),
      rent_price: 1000,
      deposit: 1000,
      bedroom: 1,
      living_room: 0,
      toilet: 1,
      area: 30,
      status: 0,
      updated_at: "2026-06-17T00:00:00.000Z",
      building: { lng: "113.293204", lat: "23.225461" }
    };
  });
}
