import type { House } from "@ai-house-assistant/shared";

type FetchFn = typeof fetch;

export type McpClientOptions = {
  url: string;
  authToken: string;
  fetchFn?: FetchFn;
};

type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
};

type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: number;
  error: {
    code: number;
    message: string;
  };
};

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export class McpClient {
  private nextId = 1;
  private readonly fetchFn: FetchFn;

  constructor(private readonly options: McpClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchFn(this.options.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.authToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "tools/call",
        params: {
          name,
          arguments: args
        }
      })
    });

    if (!response.ok) {
      throw new Error(`MCP request failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as JsonRpcResponse;
    if ("error" in payload) {
      throw new Error(payload.error.message);
    }
    return payload.result;
  }

  async searchHouses(args: Record<string, unknown>): Promise<House[]> {
    const result = await this.callTool("search_houses", args);
    return parseMcpRows(result).map(normalizeHouse).filter((house): house is House => house !== null);
  }

  async getHouseDetailSafe(houseId: string): Promise<unknown> {
    try {
      return await this.callTool("get_house_detail", { houseId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("house_images")) {
        return {
          houseId,
          images: [],
          unavailableReason: "house_images table is unavailable"
        };
      }
      throw error;
    }
  }
}

function parseMcpRows(result: unknown): unknown[] {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (!text) {
    return [];
  }
  const parsed = JSON.parse(text) as { rows?: unknown[] };
  return parsed.rows ?? [];
}

function normalizeHouse(row: unknown): House | null {
  const source = row as Record<string, unknown>;
  const houseId = source.house_id ?? source.houseId;
  const buildingId = source.building_id ?? source.buildingId;
  if (typeof houseId !== "string" || typeof buildingId !== "string") {
    return null;
  }

  return {
    houseId,
    buildingId,
    buildingName: String(source.building_name ?? source.buildingName ?? ""),
    houseNumber: String(source.house_number ?? source.houseNumber ?? ""),
    rentPrice: Number(source.rent_price ?? source.rentPrice ?? 0),
    deposit: Number(source.deposit ?? 0),
    bedroom: Number(source.bedroom ?? 0),
    livingRoom: Number(source.living_room ?? source.livingRoom ?? 0),
    toilet: Number(source.toilet ?? 0),
    area: Number(source.area ?? 0),
    direction: String(source.direction ?? ""),
    status: Number(source.status ?? 0),
    updatedAt: String(source.updated_at ?? source.updatedAt ?? ""),
    lng: source.lng === "" || source.lng === undefined ? null : Number(source.lng),
    lat: source.lat === "" || source.lat === undefined ? null : Number(source.lat)
  };
}
