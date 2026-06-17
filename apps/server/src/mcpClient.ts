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
type McpRowsPayload = {
  rows?: unknown[];
  pagination?: {
    page?: number;
    pageSize?: number;
    total?: number;
    totalPages?: number;
    hasNext?: boolean;
  };
};

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
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream"
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

    const payload = await parseJsonRpcResponse(response);
    if ("error" in payload) {
      throw new Error(payload.error.message);
    }
    return payload.result;
  }

  async searchHouses(args: Record<string, unknown>): Promise<House[]> {
    const rows = await this.searchPaginatedRows("search_houses", args);
    return rows.map(normalizeHouse).filter((house): house is House => house !== null);
  }

  async searchHousesGeo(args: Record<string, unknown>): Promise<House[]> {
    const rows = await this.searchPaginatedRows("search_houses_geo", args);
    return rows.map(normalizeHouse).filter((house): house is House => house !== null);
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

  private async searchPaginatedRows(name: string, args: Record<string, unknown>): Promise<unknown[]> {
    const { maxResults, ...toolArgs } = args;
    const requestedMax = toPositiveInteger(maxResults);
    if (requestedMax === null) {
      return parseMcpRows(await this.callTool(name, toolArgs));
    }

    const pageSize = Math.min(toPositiveInteger(toolArgs.pageSize) ?? requestedMax, 50);
    const startPage = toPositiveInteger(toolArgs.page) ?? 1;
    const rows: unknown[] = [];
    let page = startPage;

    while (rows.length < requestedMax) {
      const payload = parseMcpRowsPayload(await this.callTool(name, { ...toolArgs, page, pageSize }));
      rows.push(...payload.rows);
      if (!payload.pagination?.hasNext || payload.rows.length === 0) break;
      page += 1;
    }

    return rows.slice(0, requestedMax);
  }
}

async function parseJsonRpcResponse(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers?.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    return (await response.json()) as JsonRpcResponse;
  }

  const eventStream = await response.text();
  const data = eventStream
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  if (!data) {
    throw new Error("MCP event-stream response did not contain data");
  }
  return JSON.parse(data) as JsonRpcResponse;
}

function parseMcpRows(result: unknown): unknown[] {
  return parseMcpRowsPayload(result).rows;
}

function parseMcpRowsPayload(result: unknown): { rows: unknown[]; pagination: McpRowsPayload["pagination"] | null } {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (!text) {
    return { rows: [], pagination: null };
  }
  const parsed = JSON.parse(text) as McpRowsPayload;
  return { rows: parsed.rows ?? [], pagination: parsed.pagination ?? null };
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
  const coordinate = normalizeCoordinate(source.lng ?? building.lng, source.lat ?? building.lat);

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
    lng: coordinate.lng,
    lat: coordinate.lat,
    address: String(source.address ?? building.address ?? ""),
    coverImageUrl: extractImageUrls(source)[0] ?? null
  };
}

function normalizeCoordinate(rawLng: unknown, rawLat: unknown): { lng: number | null; lat: number | null } {
  const lng = toNullableNumber(rawLng);
  const lat = toNullableNumber(rawLat);
  if (lng === null || lat === null) {
    return { lng: null, lat: null };
  }
  if (isChinaCoordinate(lng, lat)) {
    return { lng, lat };
  }
  if (isChinaCoordinate(lat, lng)) {
    return { lng: lat, lat: lng };
  }
  return { lng: null, lat: null };
}

function isChinaCoordinate(lng: number, lat: number): boolean {
  return lng >= 73 && lng <= 136 && lat >= 3 && lat <= 54;
}

function toNullableNumber(value: unknown): number | null {
  if (value === "" || value === undefined || value === null) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue !== 0 ? numberValue : null;
}

function toPositiveInteger(value: unknown): number | null {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return null;
  const integer = Math.floor(numberValue);
  return integer > 0 ? integer : null;
}

function extractImageUrls(value: unknown): string[] {
  const source = value as Record<string, unknown>;
  const images = source.images ?? source.image_urls ?? source.imageUrls;
  if (!Array.isArray(images)) return [];
  return images
    .map((image) => {
      if (typeof image === "string") return normalizeImageUrl(image);
      if (!isRecord(image)) return null;
      const url = image.url ?? image.image_url ?? image.imageUrl ?? image.src ?? image.path;
      const prefix = typeof image.prefix === "string" ? image.prefix : "";
      return typeof url === "string" && url.trim() ? normalizeImageUrl(url, prefix) : null;
    })
    .filter((url): url is string => Boolean(url));
}

function normalizeImageUrl(url: string, prefix = ""): string | null {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) return null;
  if (/^https?:\/\//i.test(trimmedUrl)) return trimmedUrl;
  if (prefix.trim()) {
    return `${prefix.replace(/\/$/, "")}/${trimmedUrl.replace(/^\//, "")}`;
  }
  if (trimmedUrl.startsWith("/")) {
    return `https://image.manzu365.com${trimmedUrl}`;
  }
  return trimmedUrl;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
