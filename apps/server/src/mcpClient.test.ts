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
});
