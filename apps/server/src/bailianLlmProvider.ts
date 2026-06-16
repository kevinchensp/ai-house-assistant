import {
  parseBudgetAround,
  resolveLocation,
  type RequirementExtraction,
  validateRequirementExtraction
} from "@ai-house-assistant/shared";
import type { AssistantIntent, RequirementExtractionProvider } from "./llmProvider";

type BailianLlmProviderOptions = {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchFn?: typeof fetch;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

export class BailianLlmProvider implements RequirementExtractionProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: BailianLlmProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async extractAssistantIntent(input: string): Promise<AssistantIntent> {
    const content = await this.chatJson([
      {
        role: "system",
        content: [
          "你是内部租房客服助手的意图路由器，只输出 JSON，不输出解释。",
          "根据客服输入判断应该调用哪个能力 intent。",
          "可选 type：recommend_houses, project_vacancy, area_inventory, metro_line_inventory, metro_station_inventory, area_layout_availability, price_range, distance_ranking。",
          "recommend_houses：客户给位置/预算/户型，希望推荐具体房源。",
          "project_vacancy：询问某项目、门店、楼栋还有什么空房。",
          "area_inventory：询问某区域/商圈/地铁站有什么房子/房源/空房，但没有明确户型或预算，例如“永泰有什么房子”。这类先查区域库存概览，不追问预算户型。",
          "metro_line_inventory：询问某条地铁线沿线/沿途/附近房源，例如“3号线沿途的房源”。输出 lineName，例如“3号线”。",
          "metro_station_inventory：询问具体地铁站附近房源，例如“3号线同和站房源”。输出 stationName，例如“同和”；如提到线路则输出 lineName，否则为 null。",
          "area_layout_availability：询问某区域/商圈/街道有没有某户型，例如“花都狮岭有没有一房”。这类不需要预算。",
          "price_range：询问某区域某户型价格范围、租金范围、价位。",
          "distance_ranking：询问离地铁/目标点最近、按距离排序。",
          "输出字段：type, confidence。project_vacancy 还要 projectName；metro_line_inventory 还要 lineName；metro_station_inventory 还要 stationName,lineName；其他咨询意图要 locationKeyword；涉及户型时输出 layout={bedroom,livingRoom}，未知填 null。"
        ].join("\n")
      },
      { role: "user", content: input }
    ]);
    return normalizeAssistantIntent(parseJsonContent(content));
  }

  async extractRequirement(input: string): Promise<RequirementExtraction> {
    const content = await this.chatJson([
      {
        role: "system",
        content: [
          "你是内部租房客服助手的需求解析器，只输出 JSON，不输出解释。",
          "把用户自然语言解析为 RequirementExtraction，字段必须完整。",
          "location 需包含 raw, normalized, city, district, placeType, center, confidence；无法确认时为 null。",
          "budget 需包含 target, min, max, confidence；例如 1000 左右可解析为 800-1200，九百以内解析为 max 900。",
          "layout 需包含 bedroom, livingRoom, toilet, confidence；一房可设置 bedroom=1, livingRoom=null。",
          "preferences 需包含 rentType, direction, minArea, moveInDate, features；未知填 null，features 用数组记录近地铁、带阳台、大单间、可养宠物等软偏好。",
          "缺少位置、预算、户型时写入 missingRequiredSlots，并给 followUpQuestion。"
        ].join("\n")
      },
      {
        role: "user",
        content: input
      }
    ]);

    const extracted = normalizeModelRequirement(input, parseJsonContent(content));
    return validateRequirementExtraction(repairLowConfidenceSlots(input, extracted));
  }

  private async chatJson(messages: Array<{ role: "system" | "user"; content: string }>): Promise<string> {
    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.1,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      throw new Error(`Bailian request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Bailian response did not include message content");
    }
    return content;
  }
}

function normalizeAssistantIntent(value: unknown): AssistantIntent {
  const record = isRecord(value) ? value : {};
  const type = getString(record.type);
  const confidence = Math.max(0, Math.min(1, getNumber(record.confidence) ?? 0.5));
  const layoutRecord = isRecord(record.layout) ? record.layout : {};
  const layout = {
    bedroom: getNullableNumber(layoutRecord.bedroom),
    livingRoom: getNullableNumber(layoutRecord.livingRoom)
  };
  if (type === "project_vacancy") {
    return { type, projectName: getString(record.projectName) ?? "", confidence };
  }
  if (type === "area_inventory") {
    return { type, locationKeyword: getString(record.locationKeyword) ?? "", confidence };
  }
  if (type === "metro_line_inventory") {
    return { type, lineName: getString(record.lineName) ?? "", confidence };
  }
  if (type === "metro_station_inventory") {
    return {
      type,
      stationName: getString(record.stationName) ?? "",
      lineName: getString(record.lineName),
      confidence
    };
  }
  if (type === "area_layout_availability" || type === "price_range") {
    return { type, locationKeyword: getString(record.locationKeyword) ?? "", layout, confidence };
  }
  if (type === "distance_ranking") {
    return { type, locationKeyword: getString(record.locationKeyword) ?? "", confidence };
  }
  return { type: "recommend_houses", confidence };
}

function parseJsonContent(content: string): unknown {
  const normalized = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw new Error("Bailian response was not valid JSON", { cause: error });
  }
}

function normalizeModelRequirement(input: string, value: unknown): RequirementExtraction {
  const record = isRecord(value) ? value : {};
  const modelLocation = isRecord(record.location) ? record.location : null;
  const locationRaw = getString(modelLocation?.raw) ?? getString(modelLocation?.normalized) ?? input;
  const normalizedLocation = resolveLocationCandidate(locationRaw);
  const layout = isRecord(record.layout) ? record.layout : {};
  const preferences = isRecord(record.preferences) ? record.preferences : {};

  return {
    location: modelLocation
      ? {
          raw: locationRaw,
          normalized: getString(modelLocation.normalized) ?? normalizedLocation.normalized,
          city: getString(modelLocation.city) ?? normalizedLocation.city,
          district:
            typeof modelLocation.district === "string" || modelLocation.district === null
              ? modelLocation.district
              : normalizedLocation.district,
          placeType: getPlaceType(modelLocation.placeType) ?? normalizedLocation.placeType,
          center: isCoordinate(modelLocation.center) ? modelLocation.center : normalizedLocation.center,
          confidence: getNumber(modelLocation.confidence) ?? normalizedLocation.confidence
        }
      : null,
    budget: isBudget(record.budget) ? record.budget : null,
    layout: {
      bedroom: getNullableNumber(layout.bedroom),
      livingRoom: getNullableNumber(layout.livingRoom),
      toilet: getNullableNumber(layout.toilet),
      confidence: getNumber(layout.confidence) ?? 0.5
    },
    preferences: {
      rentType: getNullableString(preferences.rentType),
      direction: getNullableString(preferences.direction),
      minArea: getNullableNumber(preferences.minArea),
      moveInDate: getNullableString(preferences.moveInDate),
      features: getStringArray(preferences.features)
    },
    missingRequiredSlots: Array.isArray(record.missingRequiredSlots)
      ? record.missingRequiredSlots.filter((slot): slot is string => typeof slot === "string")
      : [],
    shouldAskFollowUp: typeof record.shouldAskFollowUp === "boolean" ? record.shouldAskFollowUp : false,
    followUpQuestion: getNullableString(record.followUpQuestion)
  };
}

function repairLowConfidenceSlots(input: string, requirement: RequirementExtraction): RequirementExtraction {
  const repaired: RequirementExtraction = { ...requirement };
  const localLocation = resolveLocationCandidate(input);
  const shouldPreferLocalLocation =
    localLocation.confidence >= 0.5 &&
    (!repaired.location ||
      repaired.location.confidence < localLocation.confidence ||
      repaired.location.normalized.includes(localLocation.normalized));
  if (shouldPreferLocalLocation) {
    repaired.location = localLocation;
  }

  repaired.budget ??= parseBudgetAround(input) ?? parseChineseBudget(input);
  repaired.preferences = {
    ...repaired.preferences,
    features: mergeFeatures(repaired.preferences.features, extractPreferenceFeatures(input))
  };
  repaired.missingRequiredSlots = getMissingRequiredSlots(repaired);
  repaired.shouldAskFollowUp = repaired.missingRequiredSlots.length > 0;
  repaired.followUpQuestion = repaired.shouldAskFollowUp
    ? "请问客户主要想看哪个区域、预算大概多少，以及户型要求是什么？"
    : null;

  return repaired;
}

function resolveLocationCandidate(input: string): ReturnType<typeof resolveLocation> {
  const direct = resolveLocation(input);
  if (direct.confidence >= 0.5) {
    return direct;
  }

  const candidate = input.match(/(白云东平|东平地铁站|东平|白云石井|石井街道|石井|白云龙归|龙归地铁站|龙归|天瑞广场|白云大道北)/)?.[1];
  return candidate ? resolveLocation(candidate) : direct;
}

function extractPreferenceFeatures(input: string): string[] {
  const features: string[] = [];
  if (/近地铁|靠近地铁|地铁站|地铁口|离地铁近/.test(input)) features.push("近地铁");
  if (/阳台|带阳台|有阳台/.test(input)) features.push("带阳台");
  if (/大单间|大一点|大点|面积大|空间大/.test(input)) features.push("大单间");
  if (/可养宠物|可以养宠物|能养宠物|允许养宠物|宠物友好|养猫|养狗|带宠物/.test(input)) {
    features.push("可养宠物");
  }
  return features;
}

function mergeFeatures(current: string[], fallback: string[]): string[] {
  return Array.from(new Set([...current, ...fallback]));
}

function getMissingRequiredSlots(requirement: RequirementExtraction): string[] {
  const missingRequiredSlots: string[] = [];
  if (!requirement.location || requirement.location.confidence < 0.5) missingRequiredSlots.push("location");
  if (!requirement.budget) missingRequiredSlots.push("budget");
  if (requirement.layout.bedroom === null) missingRequiredSlots.push("layout");
  return missingRequiredSlots;
}

function parseChineseBudget(input: string): RequirementExtraction["budget"] {
  if (!/(预算|租金|以内|以下|不超过|别超过)/.test(input)) {
    return null;
  }

  for (const match of input.matchAll(/([一二两三四五六七八九十百千万零〇]+)\s*(?:元|块)?\s*(?:以内|以下|不超过|别超过)?/g)) {
    const target = chineseNumberToInteger(match[1] ?? "");
    if (!target || target < 100 || target > 100_000) {
      continue;
    }

    if (/以内|以下|不超过|别超过/.test(input)) {
      return { target, min: 0, max: target, confidence: 0.82 };
    }

    const delta = Math.round(target * 0.2);
    return { target, min: Math.max(0, target - delta), max: target + delta, confidence: 0.72 };
  }

  return null;
}

function chineseNumberToInteger(text: string): number | null {
  const digits: Record<string, number> = {
    零: 0,
    "〇": 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let result = 0;
  let section = 0;
  let number = 0;

  for (const char of text) {
    if (char in digits) {
      number = digits[char] ?? 0;
      continue;
    }
    const unit = units[char];
    if (!unit) {
      return null;
    }
    if (unit === 10000) {
      section = (section + number) * unit;
      result += section;
      section = 0;
    } else {
      section += (number || 1) * unit;
    }
    number = 0;
  }

  return result + section + number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function getNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isCoordinate(value: unknown): value is { lng: number; lat: number } {
  return isRecord(value) && getNumber(value.lng) !== null && getNumber(value.lat) !== null;
}

function isBudget(value: unknown): value is NonNullable<RequirementExtraction["budget"]> {
  return (
    isRecord(value) &&
    getNumber(value.target) !== null &&
    getNumber(value.min) !== null &&
    getNumber(value.max) !== null &&
    getNumber(value.confidence) !== null
  );
}

function getPlaceType(value: unknown): NonNullable<RequirementExtraction["location"]>["placeType"] | null {
  const allowed = ["metro_station", "business_area", "village", "road", "poi", "unknown"] as const;
  return allowed.find((item) => item === value) ?? null;
}
