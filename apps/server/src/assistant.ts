import {
  type Budget,
  type Coordinate,
  type House,
  type RankedHouse,
  type RequirementExtraction,
  type ResolvedLocation,
  distanceMeters,
  rankHouses,
  resolveLocation,
  validateRequirementExtraction
} from "@ai-house-assistant/shared";
import type { InMemoryEventLogger } from "./eventLogger";
import type { LocationResolver } from "./locationResolver";
import { extractLocationQueryCandidates } from "./locationResolver";
import type { AssistantIntent, RequirementExtractionProvider } from "./llmProvider";
import { extractRequirementByRules } from "./requirementRules";

export type AssistantMcpClient = {
  searchHouses(args: Record<string, unknown>): Promise<House[]>;
  searchHousesGeo?(args: Record<string, unknown>): Promise<House[]>;
  getHouseImageUrlsSafe?(houseId: string): Promise<string[]>;
};

export type AssistantDependencies = {
  mcpClient: AssistantMcpClient;
  eventLogger: InMemoryEventLogger;
  llmProvider?: RequirementExtractionProvider;
  locationResolver?: LocationResolver;
};

export type ChatRequest = {
  sessionId: string;
  message: string;
  clientResolvedLocation?: ResolvedLocation | null;
};

export type SearchTraceStep = {
  name: string;
  arguments: Record<string, unknown>;
  resultCount: number;
};

export type ChatResponse = {
  sessionId: string;
  answerMode: "recommend_houses" | "project_vacancy" | "price_range" | "distance_ranking" | "area_layout_availability";
  requirement: RequirementExtraction;
  followUpQuestion: string | null;
  searchTrace: SearchTraceStep[];
  recommendations: RankedHouse[];
  consultation: ConsultationResult | null;
  salesReply: {
    text: string;
    nextAction: string;
  };
};

export type ConsultationResult = {
  title: string;
  summary: string;
  metrics: Array<{ label: string; value: string }>;
};

const maxRecommendationDistanceMeters = 20000;

type ConsultationIntent =
  | { type: "project_vacancy"; projectName: string }
  | {
      type: "area_layout_availability";
      locationKeyword: string;
      layout: { bedroom: number | null; livingRoom: number | null };
    }
  | { type: "price_range"; locationKeyword: string; layout: { bedroom: number | null; livingRoom: number | null } }
  | { type: "distance_ranking"; locationKeyword: string };

export function createAssistant(dependencies: AssistantDependencies) {
  const sessionState = new Map<string, RequirementExtraction>();

  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      dependencies.eventLogger.record("message_sent", {
        sessionId: request.sessionId,
        payload: { text: request.message }
      });

      const consultationIntent = await resolveAssistantIntent(dependencies, request.message);
      if (consultationIntent) {
        return handleConsultation(dependencies, request.sessionId, request.message, consultationIntent);
      }

      const priorRequirement = sessionState.get(request.sessionId) ?? null;
      const requirement = await resolveTurnRequirement(
        dependencies,
        request.message,
        priorRequirement,
        request.clientResolvedLocation ?? null
      );
      dependencies.eventLogger.record("requirement_extracted", {
        sessionId: request.sessionId,
        payload: { requirement }
      });

      if (requirement.location) {
        dependencies.eventLogger.record("location_resolved", {
          sessionId: request.sessionId,
          payload: { location: requirement.location }
        });
      }

      if (requirement.shouldAskFollowUp) {
        dependencies.eventLogger.record("follow_up_asked", {
          sessionId: request.sessionId,
          payload: { question: requirement.followUpQuestion }
        });
        return {
          sessionId: request.sessionId,
          requirement,
          followUpQuestion: requirement.followUpQuestion,
          searchTrace: [],
          recommendations: [],
          answerMode: "recommend_houses",
          consultation: null,
          salesReply: {
            text: requirement.followUpQuestion ?? "我再确认一下客户的区域和预算后帮您找。",
            nextAction: "ask_follow_up"
          }
        };
      }

      sessionState.set(request.sessionId, requirement);

      const { houses, searchTrace } = await searchWithFallbacks(dependencies, request.sessionId, requirement);
      const locationFilteredHouses = filterHousesForLocation(houses, requirement.location?.center ?? null);
      const recommendations = await enrichRecommendationsWithImages(dependencies, rankHouses(locationFilteredHouses, {
        budget: requirement.budget,
        layout: requirement.layout,
        center: requirement.location?.center ?? null
      }).slice(0, 5));

      dependencies.eventLogger.record("recommendation_shown", {
        sessionId: request.sessionId,
        payload: { houseIds: recommendations.map((house) => house.houseId) }
      });

      const salesReply = buildSalesReply(requirement, recommendations, searchTrace);
      dependencies.eventLogger.record("reply_generated", {
        sessionId: request.sessionId,
        payload: salesReply
      });

      return {
        sessionId: request.sessionId,
        answerMode: "recommend_houses",
        requirement,
        followUpQuestion: null,
        searchTrace,
        recommendations,
        consultation: null,
        salesReply
      };
    }
  };
}

async function resolveAssistantIntent(
  dependencies: AssistantDependencies,
  message: string
): Promise<ConsultationIntent | null> {
  if (dependencies.llmProvider?.extractAssistantIntent) {
    try {
      const modelIntent = normalizeAssistantIntent(await dependencies.llmProvider.extractAssistantIntent(message));
      if (modelIntent) {
        return modelIntent;
      }
    } catch {
      // Rule intent fallback keeps the assistant usable when model routing fails.
    }
  }
  return detectConsultationIntent(message);
}

function normalizeAssistantIntent(intent: AssistantIntent): ConsultationIntent | null {
  if (intent.confidence < 0.55 || intent.type === "recommend_houses") {
    return null;
  }
  if (intent.type === "project_vacancy") {
    return intent.projectName.trim() ? { type: "project_vacancy", projectName: intent.projectName.trim() } : null;
  }
  if (intent.type === "area_layout_availability") {
    return intent.locationKeyword.trim()
      ? { type: "area_layout_availability", locationKeyword: intent.locationKeyword.trim(), layout: intent.layout }
      : null;
  }
  if (intent.type === "price_range") {
    return intent.locationKeyword.trim()
      ? { type: "price_range", locationKeyword: intent.locationKeyword.trim(), layout: intent.layout }
      : null;
  }
  return intent.locationKeyword.trim()
    ? { type: "distance_ranking", locationKeyword: intent.locationKeyword.trim() }
    : null;
}

function detectConsultationIntent(message: string): ConsultationIntent | null {
  const compact = message.replace(/\s+/g, "");
  const projectMatch = compact.match(/^(.+?)(?:还有|有|剩)(?:什么|哪些|多少)?.*空房/);
  if (projectMatch?.[1] && !/(房源|房子)$/.test(projectMatch[1])) {
    return { type: "project_vacancy", projectName: projectMatch[1] };
  }

  if (/(有没有|有无|还有没有|有吗).*(一房|一居室|一室|单间|两房|两室|三房|三室)/.test(compact)) {
    return {
      type: "area_layout_availability",
      locationKeyword: extractConsultationLocationKeyword(compact) ?? "目标区域",
      layout: extractConsultationLayout(compact)
    };
  }

  if (/价格范围|价位|多少钱|租金范围/.test(compact)) {
    const layout = extractConsultationLayout(compact);
    const locationKeyword = extractConsultationLocationKeyword(compact) ?? "目标区域";
    return { type: "price_range", locationKeyword, layout };
  }

  if (/离地铁最近|距离地铁最近|最近地铁|按距离/.test(compact)) {
    const locationKeyword = extractConsultationLocationKeyword(compact) ?? "东平";
    return { type: "distance_ranking", locationKeyword };
  }

  return null;
}

async function handleConsultation(
  dependencies: AssistantDependencies,
  sessionId: string,
  message: string,
  intent: ConsultationIntent
): Promise<ChatResponse> {
  if (intent.type === "project_vacancy") {
    return handleProjectVacancy(dependencies, sessionId, intent);
  }
  if (intent.type === "area_layout_availability") {
    return handleAreaLayoutAvailability(dependencies, sessionId, intent);
  }
  if (intent.type === "price_range") {
    return handlePriceRange(dependencies, sessionId, intent);
  }
  return handleDistanceRanking(dependencies, sessionId, message, intent);
}

async function handleAreaLayoutAvailability(
  dependencies: AssistantDependencies,
  sessionId: string,
  intent: Extract<ConsultationIntent, { type: "area_layout_availability" }>
): Promise<ChatResponse> {
  const args = {
    keyword: intent.locationKeyword,
    bedroom: intent.layout.bedroom,
    livingRoom: intent.layout.livingRoom,
    status: 0,
    pageSize: 30
  };
  const houses = await callSearch(dependencies, sessionId, "area_layout_availability", args);
  const recommendations = rankHouses(houses, {
    budget: null,
    layout: { ...intent.layout, toilet: null },
    center: null
  }).slice(0, 10);
  const layoutLabel = formatConsultationLayout(intent.layout);
  const rentPrices = recommendations.map((house) => house.rentPrice).filter((price) => price > 0);
  const minRent = rentPrices.length ? Math.min(...rentPrices) : null;
  const maxRent = rentPrices.length ? Math.max(...rentPrices) : null;
  const consultation = {
    title: `${intent.locationKeyword}${layoutLabel}空房`,
    summary: recommendations.length
      ? `${intent.locationKeyword}${layoutLabel}目前查到 ${recommendations.length} 套空房。`
      : `${intent.locationKeyword}${layoutLabel}当前暂未查到空房。`,
    metrics: [
      { label: "空房数", value: `${recommendations.length}套` },
      { label: "最低价", value: minRent !== null ? `${minRent}元` : "暂无" },
      { label: "最高价", value: maxRent !== null ? `${maxRent}元` : "暂无" }
    ]
  };

  return buildConsultationResponse({
    sessionId,
    answerMode: "area_layout_availability",
    consultation,
    recommendations,
    searchTrace: [{ name: "area_layout_availability", arguments: args, resultCount: houses.length }],
    salesReply: {
      text: buildAvailabilityReply(intent.locationKeyword, layoutLabel, recommendations),
      nextAction: "copy_reply"
    }
  });
}

async function handleProjectVacancy(
  dependencies: AssistantDependencies,
  sessionId: string,
  intent: Extract<ConsultationIntent, { type: "project_vacancy" }>
): Promise<ChatResponse> {
  const args = { keyword: intent.projectName, status: 0, pageSize: 30 };
  const houses = await callSearch(dependencies, sessionId, "project_vacancy", args);
  const recommendations = rankHouses(houses, {
    budget: null,
    layout: { bedroom: null, livingRoom: null, toilet: null },
    center: null
  }).slice(0, 10);
  const consultation = {
    title: `${intent.projectName}空房`,
    summary: recommendations.length
      ? `${intent.projectName}目前查到 ${recommendations.length} 套空房。`
      : `${intent.projectName}当前暂未查到空房。`,
    metrics: [
      { label: "空房数", value: `${recommendations.length}套` },
      { label: "最低价", value: recommendations.length ? `${Math.min(...recommendations.map((house) => house.rentPrice))}元` : "暂无" },
      { label: "最高价", value: recommendations.length ? `${Math.max(...recommendations.map((house) => house.rentPrice))}元` : "暂无" }
    ]
  };

  return buildConsultationResponse({
    sessionId,
    answerMode: "project_vacancy",
    consultation,
    recommendations,
    searchTrace: [{ name: "project_vacancy", arguments: args, resultCount: houses.length }],
    salesReply: {
      text: buildProjectVacancyReply(intent.projectName, recommendations),
      nextAction: "copy_reply"
    }
  });
}

async function handlePriceRange(
  dependencies: AssistantDependencies,
  sessionId: string,
  intent: Extract<ConsultationIntent, { type: "price_range" }>
): Promise<ChatResponse> {
  const args = {
    keyword: intent.locationKeyword,
    bedroom: intent.layout.bedroom,
    livingRoom: intent.layout.livingRoom,
    status: 0,
    pageSize: 50
  };
  const houses = await callSearch(dependencies, sessionId, "price_range", args);
  const prices = houses.map((house) => house.rentPrice).filter((price) => price > 0).sort((a, b) => a - b);
  const min = prices[0] ?? null;
  const max = prices.at(-1) ?? null;
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  const layoutLabel = formatConsultationLayout(intent.layout);
  const consultation = {
    title: `${intent.locationKeyword}${layoutLabel}价格范围`,
    summary: min !== null && max !== null
      ? `${intent.locationKeyword}${layoutLabel}当前样本价格约 ${min}-${max}元，中位价约 ${median}元。`
      : `${intent.locationKeyword}${layoutLabel}当前样本不足，暂时无法给出稳定价格范围。`,
    metrics: [
      { label: "最低价", value: min !== null ? `${min}元` : "暂无" },
      { label: "最高价", value: max !== null ? `${max}元` : "暂无" },
      { label: "中位价", value: median !== null ? `${median}元` : "暂无" },
      { label: "样本数", value: `${prices.length}套` }
    ]
  };

  return buildConsultationResponse({
    sessionId,
    answerMode: "price_range",
    consultation,
    recommendations: [],
    searchTrace: [{ name: "price_range", arguments: args, resultCount: houses.length }],
    salesReply: {
      text: min !== null && max !== null
        ? `${intent.locationKeyword}${layoutLabel}目前查到 ${prices.length} 套样本，价格大概在 ${min}-${max}元，中位价约 ${median}元。具体还要看楼栋、面积和是否近地铁。`
        : `${intent.locationKeyword}${layoutLabel}当前样本不足，我建议先扩大到周边商圈或确认具体楼栋。`,
      nextAction: "copy_reply"
    }
  });
}

async function handleDistanceRanking(
  dependencies: AssistantDependencies,
  sessionId: string,
  message: string,
  intent: Extract<ConsultationIntent, { type: "distance_ranking" }>
): Promise<ChatResponse> {
  const resolvedLocation = resolveLocation(intent.locationKeyword);
  const center = resolvedLocation.center;
  const args = center
    ? { lng: center.lng, lat: center.lat, radiusMeters: 5000, status: 0, pageSize: 30 }
    : { keyword: intent.locationKeyword, status: 0, pageSize: 30 };
  const houses = center && dependencies.mcpClient.searchHousesGeo
    ? await callGeoSearch(dependencies, sessionId, "distance_ranking_geo", args)
    : await callSearch(dependencies, sessionId, "distance_ranking", args);
  const ranked = rankHouses(houses, {
    budget: null,
    layout: { bedroom: null, livingRoom: null, toilet: null },
    center
  })
    .filter((house) => house.distanceMeters !== null)
    .sort((a, b) => (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (b.distanceMeters ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 10);
  const locationName = resolvedLocation.normalized || intent.locationKeyword;
  const consultation = {
    title: `${locationName}距离排序`,
    summary: ranked.length
      ? `已按距离${locationName}由近到远排序 ${ranked.length} 套房源。`
      : `暂未查到带坐标的${locationName}附近房源。`,
    metrics: [
      { label: "排序方式", value: "由近到远" },
      { label: "最近距离", value: ranked[0]?.distanceMeters !== null && ranked[0]?.distanceMeters !== undefined ? formatDistance(ranked[0].distanceMeters) : "暂无" },
      { label: "房源数", value: `${ranked.length}套` }
    ]
  };

  return buildConsultationResponse({
    sessionId,
    answerMode: "distance_ranking",
    consultation,
    recommendations: ranked,
    searchTrace: [{ name: center && dependencies.mcpClient.searchHousesGeo ? "distance_ranking_geo" : "distance_ranking", arguments: args, resultCount: houses.length }],
    salesReply: {
      text: ranked.length
        ? `我按距离${locationName}由近到远排好了，最近的是 ${ranked[0].buildingName} ${ranked[0].houseNumber}，约${formatDistance(ranked[0].distanceMeters ?? 0)}，租金${ranked[0].rentPrice}元。`
        : `${locationName}附近暂时没查到带坐标的空房，建议改用周边商圈或具体楼栋再查。`,
      nextAction: "copy_reply"
    },
    requirement: normalizeFollowUpQuestion(await resolveTurnRequirement(dependencies, message, null, null))
  });
}

function buildConsultationResponse(args: {
  sessionId: string;
  answerMode: ChatResponse["answerMode"];
  consultation: ConsultationResult;
  recommendations: RankedHouse[];
  searchTrace: SearchTraceStep[];
  salesReply: ChatResponse["salesReply"];
  requirement?: RequirementExtraction;
}): ChatResponse {
  return {
    sessionId: args.sessionId,
    answerMode: args.answerMode,
    requirement: args.requirement ?? buildEmptyConsultationRequirement(),
    followUpQuestion: null,
    searchTrace: args.searchTrace,
    recommendations: args.recommendations,
    consultation: args.consultation,
    salesReply: args.salesReply
  };
}

async function resolveTurnRequirement(
  dependencies: AssistantDependencies,
  message: string,
  priorRequirement: RequirementExtraction | null,
  clientResolvedLocation: ResolvedLocation | null
): Promise<RequirementExtraction> {
  if (priorRequirement && isNearbyAcceptance(message)) {
    return widenRequirementForNearby(priorRequirement, { widenBudget: isBudgetWidening(message) });
  }
  const requirement = await extractRequirementWithFallback(dependencies, message);
  if (
    !isLocationSpecificEnough(requirement.location) &&
    isClientResolvedLocationUsable(message, requirement.location, clientResolvedLocation)
  ) {
    return normalizeFollowUpQuestion({
      ...requirement,
      location: clientResolvedLocation
    });
  }
  return normalizeFollowUpQuestion(await resolveRequirementLocation(dependencies, message, requirement));
}

async function extractRequirementWithFallback(
  dependencies: AssistantDependencies,
  message: string
): Promise<RequirementExtraction> {
  if (dependencies.llmProvider) {
    try {
      return normalizeFollowUpQuestion(validateRequirementExtraction(await dependencies.llmProvider.extractRequirement(message)));
    } catch {
      return normalizeFollowUpQuestion(extractRequirementByRules(message));
    }
  }
  return normalizeFollowUpQuestion(extractRequirementByRules(message));
}

async function resolveRequirementLocation(
  dependencies: AssistantDependencies,
  message: string,
  requirement: RequirementExtraction
): Promise<RequirementExtraction> {
  if (!dependencies.locationResolver || isLocationSpecificEnough(requirement.location)) {
    return requirement;
  }

  const candidates = [
    requirement.location?.raw,
    requirement.location?.normalized,
    ...extractLocationQueryCandidates(message)
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));

  for (const candidate of [...new Set(candidates)]) {
    try {
      const location = await dependencies.locationResolver.resolve(candidate);
      if (isLocationSpecificEnough(location)) {
        return {
          ...requirement,
          location
        };
      }
    } catch (error) {
      dependencies.eventLogger.record("mcp_failed", {
        sessionId: "location_resolver",
        payload: { name: "resolve_location", message: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  return requirement;
}

function normalizeFollowUpQuestion(requirement: RequirementExtraction): RequirementExtraction {
  const missingRequiredSlots = getMissingRequiredSlots(requirement);
  return validateRequirementExtraction({
    ...requirement,
    missingRequiredSlots,
    shouldAskFollowUp: missingRequiredSlots.length > 0,
    followUpQuestion: missingRequiredSlots.length > 0 ? buildFollowUpQuestion(missingRequiredSlots) : null
  });
}

function getMissingRequiredSlots(requirement: RequirementExtraction): string[] {
  const missingRequiredSlots: string[] = [];
  if (!isLocationSpecificEnough(requirement.location)) missingRequiredSlots.push("location");
  if (!requirement.budget) missingRequiredSlots.push("budget");
  if (requirement.layout.bedroom === null) missingRequiredSlots.push("layout");
  return missingRequiredSlots;
}

function isLocationSpecificEnough(location: RequirementExtraction["location"]): boolean {
  if (!location || location.confidence < 0.5) {
    return false;
  }
  if (location.placeType === "unknown" || !location.center) {
    return false;
  }
  return !/(区|市)$/.test(location.normalized);
}

function isClientResolvedLocationUsable(
  message: string,
  modelLocation: RequirementExtraction["location"],
  clientLocation: ResolvedLocation | null
): clientLocation is ResolvedLocation {
  if (!clientLocation) {
    return false;
  }
  if (!isLocationSpecificEnough(clientLocation)) {
    return false;
  }
  const normalizedMessage = normalizeLocationText(message);
  const clientName = normalizeLocationText(clientLocation.normalized);
  const clientRaw = normalizeLocationText(clientLocation.raw);
  if (clientName && normalizedMessage.includes(clientName)) {
    return true;
  }
  if (clientRaw && !isAdministrativeOnlyLocationText(clientRaw) && normalizedMessage.includes(clientRaw)) {
    return true;
  }
  if (modelLocation && isAdministrativeOnlyLocationText(modelLocation.normalized)) {
    return false;
  }
  return Boolean(clientRaw && normalizedMessage.includes(clientRaw));
}

function normalizeLocationText(text: string): string {
  return text.replace(/\s+/g, "").replace(/市/g, "");
}

function isAdministrativeOnlyLocationText(text: string): boolean {
  return /^(广州|广州市|白云|白云区|广州市白云区|黄埔|黄埔区|广州市黄埔区)$/.test(text.trim());
}

function extractConsultationLayout(message: string): { bedroom: number | null; livingRoom: number | null } {
  if (/一居室|一房|一室|1室|1房|单间/.test(message)) {
    return { bedroom: 1, livingRoom: /一室一厅|1室1厅/.test(message) ? 1 : null };
  }
  if (/两居室|两房|二室|2室|2房/.test(message)) {
    return { bedroom: 2, livingRoom: null };
  }
  if (/三居室|三房|三室|3室|3房/.test(message)) {
    return { bedroom: 3, livingRoom: null };
  }
  return { bedroom: null, livingRoom: null };
}

function extractConsultationLocationKeyword(message: string): string | null {
  const cleaned = message
    .replace(/^(?:广州(?:市)?)?(?:白云区|白云|黄埔区|黄埔)?/, "")
    .replace(/一居室|一房|一室一厅|一室|单间|两房|两室|三房|三室|1室1厅|1室|2室|3室/g, "")
    .replace(/价格范围|租金范围|价位|多少钱|离地铁最近|距离地铁最近|最近地铁|按距离|房源排序|房源|排序|的/g, "")
    .replace(/[？?。,.，\s]/g, "")
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}

function formatConsultationLayout(layout: { bedroom: number | null; livingRoom: number | null }): string {
  if (layout.bedroom === 1 && layout.livingRoom === 1) return "一室一厅";
  if (layout.bedroom === 1) return "一居室";
  if (layout.bedroom === 2) return "两房";
  if (layout.bedroom === 3) return "三房";
  return "";
}

function buildEmptyConsultationRequirement(): RequirementExtraction {
  return validateRequirementExtraction({
    location: null,
    budget: null,
    layout: { bedroom: null, livingRoom: null, toilet: null, confidence: 0.1 },
    preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
    missingRequiredSlots: [],
    shouldAskFollowUp: false,
    followUpQuestion: null
  });
}

function buildProjectVacancyReply(projectName: string, recommendations: RankedHouse[]): string {
  if (recommendations.length === 0) {
    return `${projectName}当前暂时没查到空房，我建议再看同商圈或附近项目。`;
  }
  const lines = recommendations
    .slice(0, 5)
    .map((house, index) => `${index + 1}. ${house.buildingName} ${house.houseNumber}，${house.bedroom}室${house.livingRoom}厅，${house.area}平，${house.rentPrice}元`);
  return `${projectName}目前查到 ${recommendations.length} 套空房：\n${lines.join("\n")}\n可以先把价格和户型最合适的发给客户确认。`;
}

function buildAvailabilityReply(locationKeyword: string, layoutLabel: string, recommendations: RankedHouse[]): string {
  if (recommendations.length === 0) {
    return `${locationKeyword}${layoutLabel}当前暂时没查到空房，可以帮客户看看周边位置或相近户型。`;
  }
  const rentPrices = recommendations.map((house) => house.rentPrice).filter((price) => price > 0);
  const priceText = rentPrices.length ? `，价格大概 ${Math.min(...rentPrices)}-${Math.max(...rentPrices)}元` : "";
  const lines = recommendations
    .slice(0, 3)
    .map((house, index) => `${index + 1}. ${house.buildingName} ${house.houseNumber}，${house.area}平，${house.rentPrice}元`);
  return `${locationKeyword}${layoutLabel}目前有 ${recommendations.length} 套空房${priceText}：\n${lines.join("\n")}\n可以先挑价格和位置合适的发给客户。`;
}

function formatDistance(distance: number): string {
  if (distance < 1000) return `${Math.round(distance)}米`;
  return `${(distance / 1000).toFixed(1)}公里`;
}

function buildFollowUpQuestion(missingRequiredSlots: string[]): string {
  if (missingRequiredSlots.length === 1 && missingRequiredSlots[0] === "location") {
    return "白云区范围比较大，客户更想看哪个具体位置？可以补充地铁站、商圈、街道或小区，例如东平、永泰、龙归、石井。";
  }

  if (missingRequiredSlots.length === 1 && missingRequiredSlots[0] === "layout") {
    return "客户对户型有要求吗？如果没特别要求，我可以先按常见一居室推荐，包含单间和一室一厅。";
  }

  const labels = missingRequiredSlots.map((slot) => {
    if (slot === "location") return "具体位置（区域内的地铁站、商圈、街道或小区）";
    if (slot === "budget") return "预算";
    if (slot === "layout") return "户型";
    return slot;
  });
  return `请再确认客户的${labels.join("、")}要求。`;
}

function isNearbyAcceptance(message: string): boolean {
  return /周边可以|附近也行|附近可以|可以周边|预算.*上浮|上浮.*预算|可以/.test(message.trim());
}

function isBudgetWidening(message: string): boolean {
  return /预算.*上浮|上浮.*预算|贵点也行|加点预算|预算可以高/.test(message);
}

function widenRequirementForNearby(
  requirement: RequirementExtraction,
  options: { widenBudget: boolean }
): RequirementExtraction {
  const widenedBudget = options.widenBudget && requirement.budget
    ? {
        ...requirement.budget,
        max: Math.round(requirement.budget.max * 1.3),
        confidence: Math.min(1, requirement.budget.confidence + 0.03)
      }
    : requirement.budget;

  return validateRequirementExtraction({
    ...requirement,
    budget: widenedBudget,
    missingRequiredSlots: [],
    shouldAskFollowUp: false,
    followUpQuestion: null
  });
}

async function searchWithFallbacks(
  dependencies: AssistantDependencies,
  sessionId: string,
  requirement: RequirementExtraction
): Promise<{ houses: House[]; searchTrace: SearchTraceStep[] }> {
  const trace: SearchTraceStep[] = [];
  const budget = requirement.budget as Budget;
  const center = requirement.location?.center as Coordinate | null;
  const strictArgs = {
    keyword: requirement.location?.normalized,
    bedroom: requirement.layout.bedroom,
    livingRoom: requirement.layout.livingRoom,
    minRent: budget.min,
    maxRent: budget.max,
    status: 0,
    pageSize: 20
  };
  const strict = await callSearch(dependencies, sessionId, "strict_keyword", strictArgs);
  trace.push({ name: "strict_keyword", arguments: omitEmptyArgs(strictArgs), resultCount: strict.length });
  if (strict.length >= 3) {
    return { houses: strict, searchTrace: trace };
  }

  if (center && dependencies.mcpClient.searchHousesGeo) {
    const geoArgs = {
      lng: center.lng,
      lat: center.lat,
      radiusMeters: 3000,
      bedroom: requirement.layout.bedroom,
      livingRoom: requirement.layout.livingRoom,
      minRent: budget.min,
      maxRent: budget.max,
      status: 0,
      pageSize: 20
    };
    const geo = await callGeoSearch(dependencies, sessionId, "geo_radius_fallback", geoArgs);
    trace.push({ name: "geo_radius_fallback", arguments: omitEmptyArgs(geoArgs), resultCount: geo.length });
    if (strict.length + geo.length > 0) {
      return { houses: [...strict, ...geo], searchTrace: trace };
    }
  }

  const fallbackArgs = {
    keyword: requirement.location?.district?.replace("区", "") ?? requirement.location?.normalized,
    bedroom: requirement.layout.bedroom,
    livingRoom: requirement.layout.livingRoom,
    minRent: budget.min,
    maxRent: budget.max,
    status: 0,
    pageSize: 20
  };
  const fallback = await callSearch(dependencies, sessionId, "district_fallback", fallbackArgs);
  trace.push({ name: "district_fallback", arguments: omitEmptyArgs(fallbackArgs), resultCount: fallback.length });
  if (strict.length + fallback.length > 0) {
    return { houses: [...strict, ...fallback], searchTrace: trace };
  }

  const expandedBudget = buildExpandedBudget(budget);
  const budgetFallbackArgs = {
    ...fallbackArgs,
    maxRent: expandedBudget.max
  };
  const budgetFallback = await callSearch(dependencies, sessionId, "budget_expanded_fallback", budgetFallbackArgs);
  trace.push({
    name: "budget_expanded_fallback",
    arguments: omitEmptyArgs(budgetFallbackArgs),
    resultCount: budgetFallback.length
  });
  if (budgetFallback.length > 0) {
    return { houses: [...strict, ...fallback, ...budgetFallback], searchTrace: trace };
  }

  const inventoryBudgetFallbackArgs = {
    bedroom: requirement.layout.bedroom,
    livingRoom: requirement.layout.livingRoom,
    minRent: budget.min,
    maxRent: expandedBudget.max,
    status: 0,
    pageSize: 20
  };
  const inventoryBudgetFallback = await callSearch(
    dependencies,
    sessionId,
    "inventory_budget_fallback",
    inventoryBudgetFallbackArgs
  );
  trace.push({
    name: "inventory_budget_fallback",
    arguments: omitEmptyArgs(inventoryBudgetFallbackArgs),
    resultCount: inventoryBudgetFallback.length
  });

  return {
    houses: [...strict, ...fallback, ...budgetFallback, ...inventoryBudgetFallback],
    searchTrace: trace
  };
}

function filterHousesForLocation(houses: House[], center: Coordinate | null): House[] {
  if (!center) {
    return houses;
  }
  return houses.filter((house) => {
    if (house.lng === null || house.lat === null) {
      return false;
    }
    return distanceMeters(center, { lng: house.lng, lat: house.lat }) <= maxRecommendationDistanceMeters;
  });
}

function buildExpandedBudget(budget: Budget): Budget {
  return {
    ...budget,
    max: Math.max(Math.round(budget.max * 1.35), budget.target + 400)
  };
}

async function callSearch(
  dependencies: AssistantDependencies,
  sessionId: string,
  name: string,
  args: Record<string, unknown>
): Promise<House[]> {
  const sanitizedArgs = omitEmptyArgs(args);
  dependencies.eventLogger.record("mcp_called", { sessionId, payload: { name, args: sanitizedArgs } });
  try {
    return await dependencies.mcpClient.searchHouses(sanitizedArgs);
  } catch (error) {
    dependencies.eventLogger.record("mcp_failed", {
      sessionId,
      payload: { name, message: error instanceof Error ? error.message : String(error) }
    });
    return [];
  }
}

async function callGeoSearch(
  dependencies: AssistantDependencies,
  sessionId: string,
  name: string,
  args: Record<string, unknown>
): Promise<House[]> {
  const sanitizedArgs = omitEmptyArgs(args);
  dependencies.eventLogger.record("mcp_called", { sessionId, payload: { name, args: sanitizedArgs } });
  try {
    return await dependencies.mcpClient.searchHousesGeo?.(sanitizedArgs) ?? [];
  } catch (error) {
    dependencies.eventLogger.record("mcp_failed", {
      sessionId,
      payload: { name, message: error instanceof Error ? error.message : String(error) }
    });
    return [];
  }
}

function omitEmptyArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null && value !== undefined));
}

async function enrichRecommendationsWithImages(
  dependencies: AssistantDependencies,
  recommendations: RankedHouse[]
): Promise<RankedHouse[]> {
  if (!dependencies.mcpClient.getHouseImageUrlsSafe || recommendations.length === 0) {
    return recommendations;
  }

  return Promise.all(
    recommendations.map(async (house) => {
      if (house.coverImageUrl) return house;
      try {
        const [coverImageUrl] = await dependencies.mcpClient.getHouseImageUrlsSafe?.(house.houseId) ?? [];
        return { ...house, coverImageUrl: coverImageUrl ?? null };
      } catch {
        return { ...house, coverImageUrl: null };
      }
    })
  );
}

function buildSalesReply(
  requirement: RequirementExtraction,
  recommendations: RankedHouse[],
  searchTrace: SearchTraceStep[]
): { text: string; nextAction: string } {
  if (recommendations.length === 0) {
    return {
      text: "当前条件暂时没看到合适的空置房源，我建议先确认客户是否能接受周边位置或预算上浮一点。",
      nextAction: "ask_customer_flexibility"
    };
  }

  const strictHadResults = searchTrace[0]?.resultCount && searchTrace[0].resultCount > 0;
  const requirementLayout = formatRequirementLayout(requirement);
  const prefix = strictHadResults
    ? `${requirement.location?.normalized ?? "目标位置"}附近有几套比较匹配的房源。`
    : `${requirement.location?.normalized ?? "目标位置"}附近暂时没看到完全匹配的${requirementLayout} ${requirement.budget?.target ?? ""} 左右房源，我帮您往周边扩大了一圈。`;
  const lines = recommendations
    .slice(0, 3)
    .map(
      (house, index) =>
        `${index + 1}. ${house.buildingName}-${house.houseNumber}，${house.bedroom}室${house.livingRoom}厅，${house.area}平，租金${house.rentPrice}元，${house.recommendationReason}`
    );

  return {
    text: `${prefix}\n${lines.join("\n")}\n您看我先发两套最接近的给客户确认吗？`,
    nextAction: "copy_reply"
  };
}

function formatRequirementLayout(requirement: RequirementExtraction): string {
  const bedroom = requirement.layout.bedroom === null ? "" : `${requirement.layout.bedroom}室`;
  const livingRoom = requirement.layout.livingRoom === null ? "" : `${requirement.layout.livingRoom}厅`;
  return bedroom || livingRoom ? `${bedroom}${livingRoom}` : "目标户型";
}
