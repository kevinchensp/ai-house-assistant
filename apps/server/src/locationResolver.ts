import type { ResolvedLocation } from "@ai-house-assistant/shared";
import { fetchWithTimeout } from "./fetchWithTimeout";

type AmapLocationResolverOptions = {
  apiKey: string;
  city?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

type AmapPoi = {
  name?: string;
  type?: string;
  cityname?: string;
  adname?: string;
  address?: string | unknown[];
  location?: string;
};

type AmapPlaceTextResponse = {
  status?: string;
  info?: string;
  pois?: AmapPoi[];
};

export type LocationResolver = {
  resolve(query: string): Promise<ResolvedLocation | null>;
};

export class AmapLocationResolver implements LocationResolver {
  private readonly fetchFn: typeof fetch;
  private readonly city: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: AmapLocationResolverOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.city = options.city ?? "广州";
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async resolve(query: string): Promise<ResolvedLocation | null> {
    const cleanQuery = query.trim();
    if (!cleanQuery || isAdministrativeOnly(cleanQuery)) {
      return null;
    }

    const url = new URL("https://restapi.amap.com/v3/place/text");
    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("keywords", cleanQuery);
    url.searchParams.set("city", this.city);
    url.searchParams.set("citylimit", "true");
    url.searchParams.set("offset", "5");
    url.searchParams.set("page", "1");
    url.searchParams.set("extensions", "base");

    const response = await fetchWithTimeout(this.fetchFn, url, {}, this.timeoutMs);
    if (!response.ok) {
      throw new Error(`Amap place search failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as AmapPlaceTextResponse;
    if (payload.status !== "1") {
      throw new Error(`Amap place search failed: ${payload.info ?? "unknown error"}`);
    }

    const poi = payload.pois?.find((item) => toCoordinate(item.location) !== null);
    if (!poi?.name || !poi.location) {
      return null;
    }

    const center = toCoordinate(poi.location);
    if (!center) return null;

    return {
      raw: cleanQuery,
      normalized: poi.name,
      city: normalizeCity(poi.cityname) ?? this.city,
      district: typeof poi.adname === "string" && poi.adname ? poi.adname : null,
      placeType: mapAmapTypeToPlaceType(poi.type),
      center,
      confidence: getConfidence(cleanQuery, poi)
    };
  }
}

export function extractLocationQueryCandidates(message: string): string[] {
  const normalized = message
    .replace(/\d{3,5}\s*(?:元|块|左右|以内|附近|上下)?/g, " ")
    .replace(/一居室|一房|一室一厅|一室|单间|大单间|两房|两室|三房|三室|预算|帮我找|客户想要|客户要|想找|找个|房子|房源|靠近地铁|近地铁|最好|有阳台|带阳台/g, " ")
    .replace(/[，。,.\s]+/g, " ")
    .trim();
  const candidates = new Set<string>();

  for (const part of normalized.split(/\s+/)) {
    const cleaned = stripAdministrativePrefix(part);
    if (cleaned.length >= 2) candidates.add(cleaned);
    if (part.length >= 2) candidates.add(part);
  }
  if (normalized) candidates.add(normalized);

  return [...candidates].filter((candidate) => !isAdministrativeOnly(candidate));
}

function toCoordinate(location: unknown): { lng: number; lat: number } | null {
  if (typeof location !== "string") return null;
  const [lngText, latText] = location.split(",");
  const lng = Number(lngText);
  const lat = Number(latText);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

function mapAmapTypeToPlaceType(type: unknown): ResolvedLocation["placeType"] {
  const text = typeof type === "string" ? type : "";
  if (text.includes("地铁站")) return "metro_station";
  if (text.includes("商务住宅") || text.includes("购物") || text.includes("生活服务")) return "business_area";
  if (text.includes("道路")) return "road";
  if (text.includes("村庄") || text.includes("乡镇")) return "village";
  return "poi";
}

function getConfidence(query: string, poi: AmapPoi): number {
  if (poi.name === query) return 0.9;
  if (poi.name?.includes(query) || query.includes(poi.name ?? "")) return 0.82;
  return 0.68;
}

function normalizeCity(cityname: unknown): string | null {
  if (typeof cityname !== "string" || !cityname) return null;
  return cityname.replace(/市$/, "");
}

function isAdministrativeOnly(query: string): boolean {
  return /^(广州|广州市|白云|白云区|广州市白云区|黄埔|黄埔区|广州市黄埔区)$/.test(query.trim());
}

function stripAdministrativePrefix(query: string): string {
  return query.trim().replace(/^(?:广州(?:市)?)?(?:白云区|白云|黄埔区|黄埔)/, "");
}
