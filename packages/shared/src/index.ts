import { z } from "zod";

export const CoordinateSchema = z.object({
  lng: z.number(),
  lat: z.number()
});

export type Coordinate = z.infer<typeof CoordinateSchema>;

export const BudgetSchema = z.object({
  target: z.number(),
  min: z.number(),
  max: z.number(),
  confidence: z.number().min(0).max(1)
});

export type Budget = z.infer<typeof BudgetSchema>;

export const LocationSchema = z.object({
  raw: z.string(),
  normalized: z.string(),
  city: z.string(),
  district: z.string().nullable(),
  placeType: z.enum(["metro_station", "business_area", "village", "road", "poi", "unknown"]),
  center: CoordinateSchema.nullable(),
  confidence: z.number().min(0).max(1)
});

export type ResolvedLocation = z.infer<typeof LocationSchema>;

export const LayoutSchema = z.object({
  bedroom: z.number().nullable(),
  livingRoom: z.number().nullable(),
  toilet: z.number().nullable(),
  confidence: z.number().min(0).max(1)
});

export const PreferencesSchema = z.object({
  rentType: z.string().nullable(),
  direction: z.string().nullable(),
  minArea: z.number().nullable(),
  moveInDate: z.string().nullable()
});

export const RequirementExtractionSchema = z.object({
  location: LocationSchema.nullable(),
  budget: BudgetSchema.nullable(),
  layout: LayoutSchema,
  preferences: PreferencesSchema,
  missingRequiredSlots: z.array(z.string()),
  shouldAskFollowUp: z.boolean(),
  followUpQuestion: z.string().nullable()
});

export type RequirementExtraction = z.infer<typeof RequirementExtractionSchema>;

export const SearchPlanStepSchema = z.object({
  name: z.string(),
  tool: z.enum(["search_houses", "search_buildings", "get_house_type_summary"]),
  arguments: z.record(z.unknown()),
  fallbackReason: z.string().nullable()
});

export const SearchPlanSchema = z.object({
  steps: z.array(SearchPlanStepSchema).min(1),
  maxToolCalls: z.number().int().min(1).max(5),
  stopWhenResultsAtLeast: z.number().int().min(1).max(20)
});

export type SearchPlan = z.infer<typeof SearchPlanSchema>;

export const HouseSchema = z.object({
  houseId: z.string(),
  buildingId: z.string(),
  buildingName: z.string(),
  houseNumber: z.string(),
  rentPrice: z.number(),
  deposit: z.number(),
  bedroom: z.number(),
  livingRoom: z.number(),
  toilet: z.number(),
  area: z.number(),
  direction: z.string(),
  status: z.number(),
  updatedAt: z.string(),
  lng: z.number().nullable(),
  lat: z.number().nullable()
});

export type House = z.infer<typeof HouseSchema>;

export type RankedHouse = House & {
  score: number;
  distanceMeters: number | null;
  recommendationReason: string;
  mismatchNote: string | null;
};

export const SalesReplySchema = z.object({
  text: z.string(),
  nextAction: z.string()
});

export type SalesReply = z.infer<typeof SalesReplySchema>;

type LocationDictionaryEntry = {
  normalized: string;
  city: string;
  district: string;
  placeType: ResolvedLocation["placeType"];
  center: Coordinate;
  aliases: string[];
  confidence: number;
};

const LOCATION_DICTIONARY: LocationDictionaryEntry[] = [
  {
    normalized: "东平",
    city: "广州",
    district: "白云区",
    placeType: "metro_station",
    center: { lng: 113.293204, lat: 23.225461 },
    aliases: ["白云东平", "东平", "东平地铁站"],
    confidence: 0.88
  },
  {
    normalized: "白云大道北",
    city: "广州",
    district: "白云区",
    placeType: "road",
    center: { lng: 113.29748, lat: 23.222149 },
    aliases: ["白云大道北", "白云大道"],
    confidence: 0.8
  },
  {
    normalized: "天瑞广场",
    city: "广州",
    district: "白云区",
    placeType: "business_area",
    center: { lng: 113.29748, lat: 23.222149 },
    aliases: ["天瑞广场", "白云天瑞广场"],
    confidence: 0.82
  },
  {
    normalized: "石井",
    city: "广州",
    district: "白云区",
    placeType: "business_area",
    center: { lng: 113.2558, lat: 23.2036 },
    aliases: ["白云石井", "石井", "石井街道"],
    confidence: 0.84
  }
];

export function parseBudgetAround(input: string): Budget | null {
  const match = input.match(/(\d{3,5})\s*(?:元|块|左右|以内|附近|上下)?/);
  if (!match) {
    return null;
  }

  const target = Number(match[1]);
  const delta = Math.round(target * 0.2);

  return {
    target,
    min: Math.max(0, target - delta),
    max: target + delta,
    confidence: input.includes("左右") || input.includes("预算") ? 0.9 : 0.75
  };
}

export function resolveLocation(raw: string): ResolvedLocation {
  const entry = LOCATION_DICTIONARY.find((candidate) =>
    candidate.aliases.some((alias) => isLocationAliasMatch(raw, alias, candidate.district))
  );

  if (!entry) {
    return {
      raw,
      normalized: raw,
      city: "广州",
      district: null,
      placeType: "unknown",
      center: null,
      confidence: 0.2
    };
  }

  return {
    raw,
    normalized: entry.normalized,
    city: entry.city,
    district: entry.district,
    placeType: entry.placeType,
    center: entry.center,
    confidence: entry.confidence
  };
}

function isLocationAliasMatch(raw: string, alias: string, district: string): boolean {
  if (raw === alias) {
    return true;
  }
  if (raw.includes(district) && raw.includes(alias)) {
    return true;
  }
  return alias.length >= 4 && raw.includes(alias);
}

export function distanceMeters(a: Coordinate, b: Coordinate): number {
  const earthRadiusMeters = 6_371_000;
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLng = toRadians(b.lng - a.lng);

  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  return Math.round(earthRadiusMeters * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine)));
}

export function validateRequirementExtraction(value: unknown): RequirementExtraction {
  return RequirementExtractionSchema.parse(value);
}

export function rankHouses(
  houses: House[],
  requirement: {
    budget: Budget | null;
    layout: { bedroom: number | null; livingRoom: number | null; toilet: number | null; confidence?: number };
    center: Coordinate | null;
  }
): RankedHouse[] {
  return houses
    .map((house) => {
      const distance =
        requirement.center && house.lng !== null && house.lat !== null
          ? distanceMeters(requirement.center, { lng: house.lng, lat: house.lat })
          : null;

      const vacancyScore = house.status === 0 ? 40 : -100;
      const budgetScore = getBudgetScore(house.rentPrice, requirement.budget);
      const layoutScore = getLayoutScore(house, requirement.layout);
      const distanceScore = distance === null ? 0 : Math.max(0, 30 - Math.floor(distance / 250));
      const areaScore = Math.min(10, Math.floor(house.area / 10));
      const score = vacancyScore + budgetScore + layoutScore + distanceScore + areaScore;

      return {
        ...house,
        score,
        distanceMeters: distance,
        recommendationReason: buildRecommendationReason(house, budgetScore, layoutScore, distance),
        mismatchNote: buildMismatchNote(house, requirement)
      };
    })
    .sort((a, b) => b.score - a.score);
}

function getBudgetScore(rentPrice: number, budget: Budget | null): number {
  if (!budget) {
    return 0;
  }
  if (rentPrice >= budget.min && rentPrice <= budget.max) {
    return 30 - Math.round((Math.abs(rentPrice - budget.target) / Math.max(1, budget.target)) * 10);
  }
  return -Math.min(20, Math.round(Math.abs(rentPrice - budget.target) / 100));
}

function getLayoutScore(
  house: House,
  layout: { bedroom: number | null; livingRoom: number | null; toilet: number | null }
): number {
  let score = 0;
  if (layout.bedroom !== null && house.bedroom === layout.bedroom) score += 15;
  if (layout.livingRoom !== null && house.livingRoom === layout.livingRoom) score += 10;
  if (layout.toilet !== null && house.toilet === layout.toilet) score += 5;
  return score;
}

function buildRecommendationReason(
  house: House,
  budgetScore: number,
  layoutScore: number,
  distance: number | null
): string {
  const reasons: string[] = [];
  if (budgetScore > 0) reasons.push("租金贴近预算");
  if (layoutScore >= 20) reasons.push(`${house.bedroom}室${house.livingRoom}厅匹配需求`);
  if (house.status === 0) reasons.push("当前空置");
  if (distance !== null) reasons.push(`距离目标点约${formatDistance(distance)}`);
  if (house.area > 0) reasons.push(`面积${house.area}平`);
  return reasons.join("，");
}

function buildMismatchNote(
  house: House,
  requirement: {
    budget: Budget | null;
    layout: { bedroom: number | null; livingRoom: number | null; toilet: number | null; confidence?: number };
  }
): string | null {
  if (requirement.budget && (house.rentPrice < requirement.budget.min || house.rentPrice > requirement.budget.max)) {
    return "租金不在客户预算区间内";
  }
  if (requirement.layout.bedroom !== null && house.bedroom !== requirement.layout.bedroom) {
    return "户型与客户需求不完全一致";
  }
  return null;
}

function formatDistance(distance: number): string {
  if (distance < 1000) {
    return `${distance}米`;
  }
  return `${(distance / 1000).toFixed(1)}公里`;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
