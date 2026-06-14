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

  async searchHousesGeo(args: Record<string, unknown>): Promise<House[]> {
    const result = await this.callTool("search_houses_geo", args);
    return parseMcpRows(result).map(normalizeHouse).filter((house): house is House => house !== null);
  }

  async getHouseDetailSafe(houseId: string): Promise<unknown> {
    try {
      return parseMcpObject(await this.callTool("get_house_detail", { houseId }));
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

  async getHouseImageUrlsSafe(houseId: string): Promise<string[]> {
    const detail = await this.getHouseDetailSafe(houseId);
    return extractImageUrls(detail);
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

function parseMcpObject(result: unknown): unknown {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (!text) {
    return result;
  }
  return JSON.parse(text);
}

function normalizeHouse(row: unknown): House | null {
  const source = row as Record<string, unknown>;
  const building = isRecord(source.building) ? source.building : {};
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
    lng: toNullableNumber(source.lng ?? building.lng),
    lat: toNullableNumber(source.lat ?? building.lat),
    address: String(source.address ?? building.address ?? ""),
    coverImageUrl: extractImageUrls(source)[0] ?? null
  };
}

function toNullableNumber(value: unknown): number | null {
  if (value === "" || value === undefined || value === null) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue !== 0 ? numberValue : null;
}

function extractImageUrls(value: unknown): string[] {
  const source = value as Record<string, unknown>;
  const images = source.images ?? source.image_urls ?? source.imageUrls;
  if (!Array.isArray(images)) return [];
  return images
    .map((image) => {
      if (typeof image === "string") return image;
      if (!isRecord(image)) return null;
      const url = image.url ?? image.image_url ?? image.imageUrl ?? image.src;
      return typeof url === "string" && url.trim() ? url : null;
    })
    .filter((url): url is string => Boolean(url));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
