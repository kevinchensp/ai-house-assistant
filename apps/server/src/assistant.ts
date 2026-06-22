import {
  type Budget,
  type Coordinate,
  type CustomerProfile,
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
  enrichImages?: boolean;
};

export type ChatRequest = {
  sessionId: string;
  message: string;
  clientResolvedLocation?: ResolvedLocation | null;
  customerProfile?: CustomerProfile | null;
};

export type SearchTraceStep = {
  name: string;
  arguments: Record<string, unknown>;
  resultCount: number;
};

export type ChatResponse = {
  sessionId: string;
  answerMode:
    | "recommend_houses"
    | "project_vacancy"
    | "building_detail"
    | "area_inventory"
    | "feature_inventory"
    | "move_in_inventory"
    | "payment_inventory"
    | "commute_ranking"
    | "metro_line_inventory"
    | "metro_station_inventory"
    | "price_range"
    | "distance_ranking"
    | "area_layout_availability";
  requirement: RequirementExtraction;
  followUpQuestion: string | null;
  searchTrace: SearchTraceStep[];
  recommendations: RankedHouse[];
  recommendationPagination?: RecommendationPagination;
  consultation: ConsultationResult | null;
  salesReply: {
    text: string;
    nextAction: string;
  };
};

export type RecommendationPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

export type ConsultationResult = {
  title: string;
  summary: string;
  metrics: Array<{ label: string; value: string }>;
};

const maxRecommendationDistanceMeters = 20000;
const imageEnrichmentConcurrency = 6;
const mcpPageSize = 50;
const consultationMaxResults = 100;
const metroLineStations: Record<string, string[]> = {
  "3号线": [
    "机场北",
    "机场南",
    "高增",
    "人和",
    "龙归",
    "嘉禾望岗",
    "白云大道北",
    "永泰",
    "同和",
    "京溪南方医院",
    "梅花园",
    "燕塘",
    "林和西",
    "体育西路",
    "石牌桥",
    "岗顶",
    "华师",
    "五山",
    "天河客运站",
    "广州塔",
    "客村",
    "大塘",
    "沥滘",
    "厦滘",
    "大石",
    "汉溪长隆",
    "市桥",
    "番禺广场"
  ]
};

type ConsultationIntent =
  | { type: "project_vacancy"; projectName: string }
  | { type: "building_detail"; projectName: string }
  | { type: "area_inventory"; locationKeyword: string }
  | { type: "feature_inventory"; locationKeyword: string; feature: string }
  | { type: "move_in_inventory"; locationKeyword: string; moveInDate: string | null }
  | { type: "payment_inventory"; locationKeyword: string; payment: string }
  | { type: "commute_ranking"; locationKeyword: string; destinationKeyword: string }
  | { type: "metro_line_inventory"; lineName: string }
  | { type: "metro_station_inventory"; stationName: string; lineName: string | null }
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

      const priorRequirement = sessionState.get(request.sessionId) ?? null;
      const consultationIntent = await resolveAssistantIntent(dependencies, request.message);
      if (consultationIntent) {
        const consultationResponse = await handleConsultation(
          dependencies,
          request.sessionId,
          request.message,
          consultationIntent
        );
        return priorRequirement
          ? {
              ...consultationResponse,
              requirement: mergeRequirementSummary(priorRequirement, consultationResponse.requirement)
            }
          : consultationResponse;
      }

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
      return recommendFromRequirement(dependencies, request.sessionId, requirement, request.customerProfile ?? null);
    },

    async recommendFromRequirement(
      sessionId: string,
      requirement: RequirementExtraction,
      customerProfile: CustomerProfile | null = null
    ): Promise<ChatResponse> {
      const normalizedRequirement = normalizeFollowUpQuestion(validateRequirementExtraction(requirement));
      sessionState.set(sessionId, normalizedRequirement);
      return recommendFromRequirement(dependencies, sessionId, normalizedRequirement, customerProfile);
    }
  };
}

async function recommendFromRequirement(
  dependencies: AssistantDependencies,
  sessionId: string,
  requirement: RequirementExtraction,
  customerProfile: CustomerProfile | null = null
): Promise<ChatResponse> {
  const { houses, searchTrace } = await searchWithFallbacks(dependencies, sessionId, requirement);
  const locationFilteredHouses = filterHousesForLocation(houses, requirement.location?.center ?? null);
  const rankedRecommendations = rankHouses(locationFilteredHouses, {
    budget: requirement.budget,
    layout: requirement.layout,
    center: requirement.location?.center ?? null
  });
  const recommendations = applyCustomerProfileRanking(
    await enrichRecommendationImages(dependencies, rankedRecommendations),
    requirement,
    customerProfile
  );

  dependencies.eventLogger.record("recommendation_shown", {
    sessionId,
    payload: { houseIds: recommendations.map((house) => house.houseId) }
  });

  const salesReply = buildSalesReply(requirement, recommendations, searchTrace, customerProfile);
  dependencies.eventLogger.record("reply_generated", {
    sessionId,
    payload: salesReply
  });

  return {
    sessionId,
    answerMode: "recommend_houses",
    requirement,
    followUpQuestion: null,
    searchTrace,
    recommendations,
    consultation: null,
    salesReply
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
  if (intent.type === "building_detail") {
    return intent.projectName.trim() ? { type: "building_detail", projectName: intent.projectName.trim() } : null;
  }
  if (intent.type === "feature_inventory") {
    const locationKeyword = normalizeConsultationLocationKeyword(intent.locationKeyword);
    return locationKeyword && intent.feature.trim()
      ? { type: "feature_inventory", locationKeyword, feature: intent.feature.trim() }
      : null;
  }
  if (intent.type === "move_in_inventory") {
    const locationKeyword = normalizeConsultationLocationKeyword(intent.locationKeyword);
    return locationKeyword ? { type: "move_in_inventory", locationKeyword, moveInDate: intent.moveInDate } : null;
  }
  if (intent.type === "payment_inventory") {
    const locationKeyword = normalizeConsultationLocationKeyword(intent.locationKeyword);
    return locationKeyword && intent.payment.trim()
      ? { type: "payment_inventory", locationKeyword, payment: intent.payment.trim() }
      : null;
  }
  if (intent.type === "commute_ranking") {
    const locationKeyword = normalizeConsultationLocationKeyword(intent.locationKeyword);
    const destinationKeyword = normalizeConsultationLocationKeyword(intent.destinationKeyword);
    return locationKeyword && destinationKeyword
      ? { type: "commute_ranking", locationKeyword, destinationKeyword }
      : null;
  }
  if (intent.type === "area_inventory") {
    const locationKeyword = normalizeConsultationLocationKeyword(intent.locationKeyword);
    return locationKeyword ? { type: "area_inventory", locationKeyword } : null;
  }
  if (intent.type === "metro_line_inventory") {
    return normalizeMetroLineName(intent.lineName)
      ? { type: "metro_line_inventory", lineName: normalizeMetroLineName(intent.lineName) as string }
      : null;
  }
  if (intent.type === "metro_station_inventory") {
    const stationName = normalizeMetroStationName(intent.stationName);
    if (!stationName) return null;
    return {
      type: "metro_station_inventory",
      stationName,
      lineName: normalizeMetroLineName(intent.lineName)
    };
  }
  if (intent.type === "area_layout_availability") {
    const locationKeyword = normalizeConsultationLocationKeyword(intent.locationKeyword);
    return locationKeyword
      ? { type: "area_layout_availability", locationKeyword, layout: intent.layout }
      : null;
  }
  if (intent.type === "price_range") {
    const locationKeyword = normalizeConsultationLocationKeyword(intent.locationKeyword);
    return locationKeyword
      ? { type: "price_range", locationKeyword, layout: intent.layout }
      : null;
  }
  const locationKeyword = normalizeConsultationLocationKeyword(intent.locationKeyword);
  return locationKeyword
    ? { type: "distance_ranking", locationKeyword }
    : null;
}

function detectConsultationIntent(message: string): ConsultationIntent | null {
  const compact = message.replace(/\s+/g, "");
  const metroLineName = extractMetroLineName(compact);
  const metroStationName = extractMetroStationName(compact, metroLineName);
  if (metroStationName && /站/.test(compact)) {
    return { type: "metro_station_inventory", stationName: metroStationName, lineName: metroLineName };
  }
  if (metroLineName && /沿线|沿途|地铁线|地铁沿线/.test(compact)) {
    return { type: "metro_line_inventory", lineName: metroLineName };
  }

  const projectMatch = compact.match(/^(.+?)(?:还有|有|剩)(?:什么|哪些|多少)?.*空房/);
  if (projectMatch?.[1] && !/(房源|房子)$/.test(projectMatch[1])) {
    return { type: "project_vacancy", projectName: projectMatch[1] };
  }

  const buildingDetailMatch = compact.match(/^(.+?)(?:详情|介绍|配置|怎么样|有哪些户型|有什么户型)/);
  if (buildingDetailMatch?.[1]) {
    return { type: "building_detail", projectName: buildingDetailMatch[1] };
  }

  const feature = extractFeatureIntent(compact);
  if (feature) {
    return {
      type: "feature_inventory",
      locationKeyword: extractConsultationLocationKeyword(compact) ?? "目标区域",
      feature
    };
  }

  const payment = extractPaymentIntent(compact);
  if (payment) {
    return {
      type: "payment_inventory",
      locationKeyword: extractConsultationLocationKeyword(compact) ?? "目标区域",
      payment
    };
  }

  if (/随时入住|马上入住|近期入住|本周入住|月底入住|入住/.test(compact)) {
    return {
      type: "move_in_inventory",
      locationKeyword: extractConsultationLocationKeyword(compact) ?? "目标区域",
      moveInDate: extractMoveInDate(compact)
    };
  }

  const commuteMatch = compact.match(/(.+?)(?:到|去|离)(.+?)(?:通勤|上班|多久|近不近|方便吗)/);
  if (commuteMatch?.[1] && commuteMatch[2]) {
    return {
      type: "commute_ranking",
      locationKeyword: normalizeConsultationLocationKeyword(commuteMatch[1]) ?? commuteMatch[1],
      destinationKeyword: normalizeConsultationLocationKeyword(commuteMatch[2]) ?? commuteMatch[2]
    };
  }

  if (/有什么(?:房子|房源|房|空房)|有哪些(?:房子|房源|房|空房)/.test(compact)) {
    const layout = extractConsultationLayout(compact);
    const locationKeyword = extractConsultationLocationKeyword(compact);
    if (layout.bedroom === null && locationKeyword) {
      return { type: "area_inventory", locationKeyword };
    }
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
  if (intent.type === "building_detail") {
    return handleBuildingDetail(dependencies, sessionId, intent);
  }
  if (intent.type === "feature_inventory") {
    return handleFeatureInventory(dependencies, sessionId, intent);
  }
  if (intent.type === "move_in_inventory") {
    return handleMoveInInventory(dependencies, sessionId, intent);
  }
  if (intent.type === "payment_inventory") {
    return handlePaymentInventory(dependencies, sessionId, intent);
  }
  if (intent.type === "commute_ranking") {
    return handleCommuteRanking(dependencies, sessionId, intent);
  }
  if (intent.type === "area_inventory") {
    return handleAreaInventory(dependencies, sessionId, intent);
  }
  if (intent.type === "metro_line_inventory") {
    return handleMetroLineInventory(dependencies, sessionId, intent);
  }
  if (intent.type === "metro_station_inventory") {
    return handleMetroStationInventory(dependencies, sessionId, intent);
  }
  if (intent.type === "area_layout_availability") {
    return handleAreaLayoutAvailability(dependencies, sessionId, intent);
  }
  if (intent.type === "price_range") {
    return handlePriceRange(dependencies, sessionId, intent);
  }
  return handleDistanceRanking(dependencies, sessionId, message, intent);
}

async function handleMetroStationInventory(
  dependencies: AssistantDependencies,
  sessionId: string,
  intent: Extract<ConsultationIntent, { type: "metro_station_inventory" }>
): Promise<ChatResponse> {
  const center = await resolveConsultationCenter(dependencies, intent.stationName);
  const args = { keyword: intent.stationName, status: 0, pageSize: mcpPageSize, maxResults: consultationMaxResults };
  const houses = await callSearch(dependencies, sessionId, "metro_station_inventory", args);
  const stationCenters = new Map<string, Coordinate>();
  if (center) {
    stationCenters.set(intent.stationName, center);
  }
  const houseStationMap = new Map(houses.map((house) => [house.houseId, intent.stationName]));
  const rankedRecommendations = annotateMetroLineRecommendations(rankHouses(houses, {
    budget: null,
    layout: { bedroom: null, livingRoom: null, toilet: null },
    center
  }), houseStationMap, stationCenters);
  const recommendations = await enrichRecommendationImages(dependencies, rankedRecommendations);
  const rentPrices = recommendations.map((house) => house.rentPrice).filter((price) => price > 0);
  const stationLabel = `${intent.stationName}站`;
  const consultation = {
    title: `${stationLabel}附近空房`,
    summary: recommendations.length
      ? `${stationLabel}附近目前查到 ${recommendations.length} 套空房，已按距离优先排序。`
      : `${stationLabel}附近当前暂未查到空房。`,
    metrics: [
      { label: "空房数", value: `${recommendations.length}套` },
      { label: "价格范围", value: rentPrices.length ? `${Math.min(...rentPrices)}-${Math.max(...rentPrices)}元` : "暂无" },
      { label: "查询站点", value: intent.lineName ? `${intent.lineName} ${stationLabel}` : stationLabel }
    ]
  };

  return buildConsultationResponse({
    sessionId,
    answerMode: "metro_station_inventory",
    consultation,
    recommendations,
    searchTrace: [{ name: "metro_station_inventory", arguments: args, resultCount: houses.length }],
    salesReply: {
      text: buildMetroStationInventoryReply(intent.stationName, recommendations),
      nextAction: "copy_reply"
    }
  });
}

async function handleMetroLineInventory(
  dependencies: AssistantDependencies,
  sessionId: string,
  intent: Extract<ConsultationIntent, { type: "metro_line_inventory" }>
): Promise<ChatResponse> {
  const stations = metroLineStations[intent.lineName] ?? [];
  const stationKeywords = stations.length ? stations : [intent.lineName];
  const houseMap = new Map<string, House>();
  const houseStationMap = new Map<string, string>();
  const searchTrace: SearchTraceStep[] = [];
  const stationCenters = await resolveStationCenters(dependencies, stationKeywords);

  for (const station of stationKeywords) {
    const args = { keyword: station, status: 0, pageSize: mcpPageSize, maxResults: mcpPageSize };
    const houses = await callSearch(dependencies, sessionId, "metro_line_station_inventory", args);
    searchTrace.push({ name: "metro_line_station_inventory", arguments: args, resultCount: houses.length });
    for (const house of houses) {
      houseMap.set(house.houseId, house);
      if (!houseStationMap.has(house.houseId)) {
        houseStationMap.set(house.houseId, station);
      }
    }
  }

  const rankedRecommendations = annotateMetroLineRecommendations(rankHouses(Array.from(houseMap.values()), {
    budget: null,
    layout: { bedroom: null, livingRoom: null, toilet: null },
    center: null
  }), houseStationMap, stationCenters);
  const recommendations = await enrichRecommendationImages(dependencies, rankedRecommendations);
  const rentPrices = recommendations.map((house) => house.rentPrice).filter((price) => price > 0);
  const consultation = {
    title: `${intent.lineName}沿线空房概览`,
    summary: recommendations.length
      ? `${intent.lineName}沿线目前查到 ${recommendations.length} 套空房，覆盖 ${countMatchedStations(recommendations, stationKeywords)} 个站点关键词。`
      : `${intent.lineName}沿线当前暂未查到空房。`,
    metrics: [
      { label: "空房数", value: `${recommendations.length}套` },
      { label: "价格范围", value: rentPrices.length ? `${Math.min(...rentPrices)}-${Math.max(...rentPrices)}元` : "暂无" },
      { label: "站点范围", value: stations.length ? `${stations[0]}-${stations.at(-1)}` : intent.lineName }
    ]
  };

  return buildConsultationResponse({
    sessionId,
    answerMode: "metro_line_inventory",
    consultation,
    recommendations,
    searchTrace,
    salesReply: {
      text: buildMetroLineInventoryReply(intent.lineName, recommendations),
      nextAction: "copy_reply"
    }
  });
}

async function handleAreaInventory(
  dependencies: AssistantDependencies,
  sessionId: string,
  intent: Extract<ConsultationIntent, { type: "area_inventory" }>
): Promise<ChatResponse> {
  const center = await resolveConsultationCenter(dependencies, intent.locationKeyword);
  const args = { keyword: intent.locationKeyword, status: 0, pageSize: mcpPageSize, maxResults: consultationMaxResults };
  const houses = await callSearch(dependencies, sessionId, "area_inventory", args);
  const rankedRecommendations = rankHouses(houses, {
    budget: null,
    layout: { bedroom: null, livingRoom: null, toilet: null },
    center
  }).sort((a, b) => compareDistanceThenScore(a, b));
  const recommendations = await enrichRecommendationImages(dependencies, rankedRecommendations);
  const rentPrices = recommendations.map((house) => house.rentPrice).filter((price) => price > 0);
  const consultation = {
    title: `${intent.locationKeyword}空房概览`,
    summary: recommendations.length
      ? `${intent.locationKeyword}目前查到 ${recommendations.length} 套空房，可先按预算、户型继续筛选。`
      : `${intent.locationKeyword}当前暂未查到空房。`,
    metrics: [
      { label: "空房数", value: `${recommendations.length}套` },
      { label: "价格范围", value: rentPrices.length ? `${Math.min(...rentPrices)}-${Math.max(...rentPrices)}元` : "暂无" },
      { label: "户型覆盖", value: formatLayoutCoverage(recommendations) }
    ]
  };

  return buildConsultationResponse({
    sessionId,
    answerMode: "area_inventory",
    consultation,
    recommendations,
    searchTrace: [{ name: "area_inventory", arguments: args, resultCount: houses.length }],
    salesReply: {
      text: buildAreaInventoryReply(intent.locationKeyword, recommendations),
      nextAction: "copy_reply"
    },
    requirement: buildConsultationRequirement(intent.locationKeyword, center)
  });
}

async function handleAreaLayoutAvailability(
  dependencies: AssistantDependencies,
  sessionId: string,
  intent: Extract<ConsultationIntent, { type: "area_layout_availability" }>
): Promise<ChatResponse> {
  const center = await resolveConsultationCenter(dependencies, intent.locationKeyword);
  const args = {
    keyword: intent.locationKeyword,
    bedroom: intent.layout.bedroom,
    livingRoom: intent.layout.livingRoom,
    status: 0,
    pageSize: mcpPageSize,
    maxResults: consultationMaxResults
  };
  const houses = await callSearch(dependencies, sessionId, "area_layout_availability", args);
  const rankedRecommendations = rankHouses(houses, {
    budget: null,
    layout: { ...intent.layout, toilet: null },
    center
  }).sort((a, b) => compareDistanceThenScore(a, b));
  const recommendations = await enrichRecommendationImages(dependencies, rankedRecommendations);
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
  const args = { keyword: intent.projectName, status: 0, pageSize: mcpPageSize, maxResults: consultationMaxResults };
  const houses = await callSearch(dependencies, sessionId, "project_vacancy", args);
  const rankedRecommendations = rankHouses(houses, {
    budget: null,
    layout: { bedroom: null, livingRoom: null, toilet: null },
    center: null
  });
  const recommendations = await enrichRecommendationImages(dependencies, rankedRecommendations);
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

async function handleBuildingDetail(
  dependencies: AssistantDependencies,
  sessionId: string,
  intent: Extract<ConsultationIntent, { type: "building_detail" }>
): Promise<ChatResponse> {
  const args = { keyword: intent.projectName, status: 0, pageSize: mcpPageSize, maxResults: consultationMaxResults };
  const houses = await callSearch(dependencies, sessionId, "building_detail", args);
  const recommendations = await enrichRecommendationImages(dependencies, rankHouses(houses, {
    budget: null,
    layout: { bedroom: null, livingRoom: null, toilet: null },
    center: null
  }));
  const consultation = {
    title: `${intent.projectName}楼栋详情`,
    summary: recommendations.length
      ? `${intent.projectName}当前查到 ${recommendations.length} 套空房，可按价格、面积、户型先给客户介绍。`
      : `${intent.projectName}当前暂未查到空房，建议确认楼栋/项目名称是否准确。`,
    metrics: [
      { label: "空房数", value: `${recommendations.length}套` },
      { label: "户型覆盖", value: formatLayoutCoverage(recommendations) },
      { label: "价格范围", value: formatPriceRange(recommendations) }
    ]
  };

  return buildConsultationResponse({
    sessionId,
    answerMode: "building_detail",
    consultation,
    recommendations,
    searchTrace: [{ name: "building_detail", arguments: args, resultCount: houses.length }],
    salesReply: {
      text: buildBuildingDetailReply(intent.projectName, recommendations),
      nextAction: "copy_reply"
    }
  });
}

async function handleFeatureInventory(
  dependencies: AssistantDependencies,
  sessionId: string,
  intent: Extract<ConsultationIntent, { type: "feature_inventory" }>,
  answerMode: ChatResponse["answerMode"] = "feature_inventory"
): Promise<ChatResponse> {
  const center = await resolveConsultationCenter(dependencies, intent.locationKeyword);
  const args = {
    keyword: `${intent.locationKeyword} ${intent.feature}`,
    status: 0,
    pageSize: mcpPageSize,
    maxResults: consultationMaxResults
  };
  const houses = await callSearch(dependencies, sessionId, "feature_inventory", args);
  const recommendations = await enrichRecommendationImages(dependencies, rankHouses(houses, {
    budget: null,
    layout: { bedroom: null, livingRoom: null, toilet: null },
    center
  }).sort((a, b) => compareDistanceThenScore(a, b)));
  const consultation = {
    title: `${intent.locationKeyword}${intent.feature}房源`,
    summary: recommendations.length
      ? `${intent.locationKeyword}当前查到 ${recommendations.length} 套可能满足“${intent.feature}”的空房，建议以房源详情最终确认为准。`
      : `${intent.locationKeyword}暂未查到明确匹配“${intent.feature}”的空房。`,
    metrics: [
      { label: "条件", value: intent.feature },
      { label: "空房数", value: `${recommendations.length}套` },
      { label: "价格范围", value: formatPriceRange(recommendations) }
    ]
  };

  return buildConsultationResponse({
    sessionId,
    answerMode,
    consultation,
    recommendations,
    searchTrace: [{ name: "feature_inventory", arguments: args, resultCount: houses.length }],
    salesReply: {
      text: buildFeatureInventoryReply(intent.locationKeyword, intent.feature, recommendations),
      nextAction: "copy_reply"
    },
    requirement: addConsultationFeature(buildConsultationRequirement(intent.locationKeyword, center), intent.feature)
  });
}

async function handleMoveInInventory(
  dependencies: AssistantDependencies,
  sessionId: string,
  intent: Extract<ConsultationIntent, { type: "move_in_inventory" }>
): Promise<ChatResponse> {
  return handleFeatureInventory(dependencies, sessionId, {
    type: "feature_inventory",
    locationKeyword: intent.locationKeyword,
    feature: intent.moveInDate ?? "近期可入住"
  }, "move_in_inventory");
}

async function handlePaymentInventory(
  dependencies: AssistantDependencies,
  sessionId: string,
  intent: Extract<ConsultationIntent, { type: "payment_inventory" }>
): Promise<ChatResponse> {
  return handleFeatureInventory(dependencies, sessionId, {
    type: "feature_inventory",
    locationKeyword: intent.locationKeyword,
    feature: intent.payment
  }, "payment_inventory");
}

async function handleCommuteRanking(
  dependencies: AssistantDependencies,
  sessionId: string,
  intent: Extract<ConsultationIntent, { type: "commute_ranking" }>
): Promise<ChatResponse> {
  const destinationCenter = await resolveConsultationCenter(dependencies, intent.destinationKeyword);
  const args = { keyword: intent.locationKeyword, status: 0, pageSize: mcpPageSize, maxResults: consultationMaxResults };
  const houses = await callSearch(dependencies, sessionId, "commute_ranking", args);
  const recommendations = await enrichRecommendationImages(dependencies, rankHouses(houses, {
    budget: null,
    layout: { bedroom: null, livingRoom: null, toilet: null },
    center: destinationCenter
  }).sort((a, b) => compareDistanceThenScore(a, b)), { prioritizeImages: false });
  const consultation = {
    title: `${intent.locationKeyword}到${intent.destinationKeyword}通勤参考`,
    summary: destinationCenter
      ? `已按房源到${intent.destinationKeyword}的直线距离排序，实际通勤时间建议结合地图路线再确认。`
      : `暂时无法解析${intent.destinationKeyword}坐标，先按${intent.locationKeyword}空房给出参考。`,
    metrics: [
      { label: "目的地", value: intent.destinationKeyword },
      { label: "参考房源", value: `${recommendations.length}套` },
      { label: "最近距离", value: recommendations[0]?.distanceMeters !== null && recommendations[0]?.distanceMeters !== undefined ? formatDistance(recommendations[0].distanceMeters) : "待确认" }
    ]
  };

  return buildConsultationResponse({
    sessionId,
    answerMode: "commute_ranking",
    consultation,
    recommendations,
    searchTrace: [{ name: "commute_ranking", arguments: args, resultCount: houses.length }],
    salesReply: {
      text: buildCommuteReply(intent.locationKeyword, intent.destinationKeyword, recommendations),
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
    pageSize: mcpPageSize,
    maxResults: consultationMaxResults
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
    ? { lng: center.lng, lat: center.lat, radiusMeters: 5000, status: 0, pageSize: mcpPageSize, maxResults: consultationMaxResults }
    : { keyword: intent.locationKeyword, status: 0, pageSize: mcpPageSize, maxResults: consultationMaxResults };
  const houses = center && dependencies.mcpClient.searchHousesGeo
    ? await callGeoSearch(dependencies, sessionId, "distance_ranking_geo", args)
    : await callSearch(dependencies, sessionId, "distance_ranking", args);
  const ranked = rankHouses(houses, {
    budget: null,
    layout: { bedroom: null, livingRoom: null, toilet: null },
    center
  })
    .filter((house) => house.distanceMeters !== null)
    .sort((a, b) => (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (b.distanceMeters ?? Number.MAX_SAFE_INTEGER));
  const recommendations = await enrichRecommendationImages(dependencies, ranked, { prioritizeImages: false });
  const locationName = resolvedLocation.normalized || intent.locationKeyword;
  const consultation = {
    title: `${locationName}距离排序`,
    summary: ranked.length
      ? `已按距离${locationName}由近到远排序 ${ranked.length} 套房源。`
      : `暂未查到带坐标的${locationName}附近房源。`,
    metrics: [
      { label: "排序方式", value: "由近到远" },
      { label: "最近距离", value: recommendations[0]?.distanceMeters !== null && recommendations[0]?.distanceMeters !== undefined ? formatDistance(recommendations[0].distanceMeters) : "暂无" },
      { label: "房源数", value: `${recommendations.length}套` }
    ]
  };

  return buildConsultationResponse({
    sessionId,
    answerMode: "distance_ranking",
    consultation,
    recommendations,
    searchTrace: [{ name: center && dependencies.mcpClient.searchHousesGeo ? "distance_ranking_geo" : "distance_ranking", arguments: args, resultCount: houses.length }],
    salesReply: {
      text: recommendations.length
        ? `我按距离${locationName}由近到远排好了，最近的是 ${recommendations[0].buildingName} ${recommendations[0].houseNumber}，约${formatDistance(recommendations[0].distanceMeters ?? 0)}，租金${recommendations[0].rentPrice}元。`
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

function buildConsultationRequirement(locationKeyword: string, center: Coordinate | null): RequirementExtraction {
  return normalizeFollowUpQuestion(validateRequirementExtraction({
    location: {
      raw: locationKeyword,
      normalized: locationKeyword,
      city: "广州",
      district: null,
      placeType: center ? "poi" : "unknown",
      center,
      confidence: center ? 0.78 : 0.62
    },
    budget: null,
    layout: { bedroom: null, livingRoom: null, toilet: null, confidence: 0.1 },
    preferences: { rentType: null, direction: null, minArea: null, moveInDate: null, features: [] },
    missingRequiredSlots: [],
    shouldAskFollowUp: false,
    followUpQuestion: null
  }));
}

function mergeRequirementSummary(
  priorRequirement: RequirementExtraction,
  currentRequirement: RequirementExtraction
): RequirementExtraction {
  const priorFeatures = priorRequirement.preferences.features ?? [];
  const currentFeatures = currentRequirement.preferences.features ?? [];
  return normalizeFollowUpQuestion(validateRequirementExtraction({
    ...currentRequirement,
    location: isLocationSpecificEnough(currentRequirement.location)
      ? currentRequirement.location
      : priorRequirement.location,
    budget: currentRequirement.budget ?? priorRequirement.budget,
    layout: {
      bedroom: currentRequirement.layout.bedroom ?? priorRequirement.layout.bedroom,
      livingRoom: currentRequirement.layout.livingRoom ?? priorRequirement.layout.livingRoom,
      toilet: currentRequirement.layout.toilet ?? priorRequirement.layout.toilet,
      confidence: Math.max(currentRequirement.layout.confidence ?? 0, priorRequirement.layout.confidence ?? 0)
    },
    preferences: {
      rentType: currentRequirement.preferences.rentType ?? priorRequirement.preferences.rentType,
      direction: currentRequirement.preferences.direction ?? priorRequirement.preferences.direction,
      minArea: currentRequirement.preferences.minArea ?? priorRequirement.preferences.minArea,
      moveInDate: currentRequirement.preferences.moveInDate ?? priorRequirement.preferences.moveInDate,
      features: Array.from(new Set([...priorFeatures, ...currentFeatures]))
    }
  }));
}

async function resolveConsultationCenter(
  dependencies: AssistantDependencies,
  locationKeyword: string
): Promise<Coordinate | null> {
  if (dependencies.locationResolver) {
    try {
      const location = await dependencies.locationResolver.resolve(locationKeyword);
      if (location?.center) {
        return location.center;
      }
    } catch {
      // Fall back to the built-in dictionary if the external resolver is unavailable.
    }
  }
  return resolveLocation(locationKeyword).center;
}

function compareDistanceThenScore(a: RankedHouse, b: RankedHouse): number {
  if (a.distanceMeters !== null && b.distanceMeters !== null) {
    return a.distanceMeters - b.distanceMeters;
  }
  if (a.distanceMeters !== null) return -1;
  if (b.distanceMeters !== null) return 1;
  return b.score - a.score;
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
  const requirement = sanitizeNonLocationRequirement(
    mergeMessagePreferenceFeatures(await extractRequirementWithFallback(dependencies, message), message),
    message
  );
  if (priorRequirement && isIncrementalPreferenceUpdate(message, requirement)) {
    return mergeRequirementSummary(priorRequirement, {
      ...requirement,
      location: null
    });
  }
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

function sanitizeNonLocationRequirement(
  requirement: RequirementExtraction,
  message: string
): RequirementExtraction {
  if (!requirement.location) return requirement;
  const locationText = `${requirement.location.raw} ${requirement.location.normalized}`;
  if (!isNonLocationDemandText(message) && !isNonLocationDemandText(locationText)) {
    return requirement;
  }
  return validateRequirementExtraction({
    ...requirement,
    location: null
  });
}

function mergeMessagePreferenceFeatures(requirement: RequirementExtraction, message: string): RequirementExtraction {
  const features = extractMessagePreferenceFeatures(message);
  if (features.length === 0) return requirement;
  return validateRequirementExtraction({
    ...requirement,
    preferences: {
      ...requirement.preferences,
      features: Array.from(new Set([...(requirement.preferences.features ?? []), ...features]))
    }
  });
}

function extractMessagePreferenceFeatures(message: string): string[] {
  const features: string[] = [];
  if (/近地铁|靠近地铁|地铁站|地铁口|离地铁近/.test(message)) features.push("近地铁");
  if (/阳台|带阳台|有阳台/.test(message)) features.push("带阳台");
  if (/大单间|大一点|大点|面积大|空间大/.test(message)) features.push("大单间");
  if (/可养宠物|可以养宠物|能养宠物|允许养宠物|宠物友好|养猫|养狗|带宠物/.test(message)) {
    features.push("可养宠物");
  }
  return features;
}

function isIncrementalPreferenceUpdate(message: string, requirement: RequirementExtraction): boolean {
  const hasPreference =
    extractMessagePreferenceFeatures(message).length > 0 ||
    Boolean(requirement.preferences.rentType) ||
    Boolean(requirement.preferences.direction) ||
    Boolean(requirement.preferences.minArea) ||
    Boolean(requirement.preferences.moveInDate) ||
    requirement.preferences.features.length > 0;
  const hasCoreSlot =
    Boolean(requirement.budget) ||
    requirement.layout.bedroom !== null ||
    requirement.layout.livingRoom !== null;
  return hasPreference && !hasCoreSlot;
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
  if (isNonLocationDemandText(message)) {
    return false;
  }
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

function isNonLocationDemandText(text: string): boolean {
  return isBudgetOnlyText(text) || isPreferenceOnlyText(text);
}

function isBudgetOnlyText(text: string): boolean {
  const compact = text.replace(/[，。,.\s？?]/g, "");
  if (!compact) return false;
  if (!/[0-9一二三四五六七八九十百千万两]/.test(compact)) return false;
  const withoutBudget = compact
    .replace(/(?:预算|租金|价格|价位|大概|大约|差不多|控制在|希望|想要|要|找|房子|房源|客户|左右|上下|以内|以下|附近|出头|元|块|k|K)/g, "")
    .replace(/[0-9一二三四五六七八九十百千万两]+/g, "");
  return withoutBudget.length === 0;
}

function isPreferenceOnlyText(text: string): boolean {
  const compact = text.replace(/[，。,.\s？?]/g, "");
  if (!compact) return false;
  const withoutPreferences = compact
    .replace(/(?:最好|希望|想要|要|客户|房子|房源|可以|可|能|允许|有|带|靠近|离|近|比较|大一点|大点|宠物|养宠物|养猫|养狗|宠物友好|阳台|地铁|地铁站|地铁口|大单间)/g, "")
    .trim();
  return withoutPreferences.length === 0;
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
    .replace(/可养宠物|可以养宠物|能养宠物|允许养宠物|宠物友好|养猫|养狗|带宠物|带阳台|有阳台|阳台|电梯房|有电梯|电梯|近地铁|靠近地铁|地铁口|离地铁近/g, "")
    .replace(/押一付一|押1付1|月付|按月付|押金|付款方式|怎么付|随时入住|马上入住|近期入住|本周入住|月底入住|入住/g, "")
    .replace(/一居室|一房|一室一厅|一室|单间|两房|两室|三房|三室|1室1厅|1室|2室|3室/g, "")
    .replace(/价格范围|租金范围|价位|多少钱|离地铁最近|距离地铁最近|最近地铁|按距离|房源排序|有没有|还有没有|有无|有什么|有哪些|房源|房子|空房|排序|的/g, "")
    .replace(/[？?。,.，\s]/g, "")
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}

function normalizeConsultationLocationKeyword(locationKeyword: string): string | null {
  const cleaned = locationKeyword
    .replace(/^(?:广州(?:市)?)?(?:白云区|白云|黄埔区|黄埔)/, "")
    .replace(/[？?。,.，\s]/g, "")
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}

function extractMetroLineName(message: string): string | null {
  const match = message.match(/(?:地铁)?([0-9一二三四五六七八九十]+)号线/);
  return normalizeMetroLineName(match?.[1] ? `${match[1]}号线` : null);
}

function extractMetroStationName(message: string, lineName: string | null): string | null {
  let cleaned = message;
  if (lineName) {
    cleaned = cleaned.replace(lineName, "");
  }
  cleaned = cleaned
    .replace(/(?:地铁)?[0-9一二三四五六七八九十]+号线/g, "")
    .replace(/附近|周边|房源|房子|空房|有哪些|有什么|查|找/g, "")
    .replace(/[？?。,.，\s]/g, "");
  const explicitStation = cleaned.match(/(.+?)站/);
  const stationName = explicitStation?.[1] ?? cleaned;
  return normalizeMetroStationName(stationName);
}

function normalizeMetroStationName(stationName: string | null | undefined): string | null {
  if (!stationName) return null;
  const normalized = stationName.trim().replace(/站$/, "");
  return normalized.length >= 2 ? normalized : null;
}

function normalizeMetroLineName(lineName: string | null | undefined): string | null {
  if (!lineName) return null;
  const compact = lineName.trim().replace(/^地铁/, "");
  const chineseNumbers: Record<string, string> = {
    一号线: "1号线",
    二号线: "2号线",
    三号线: "3号线",
    四号线: "4号线",
    五号线: "5号线",
    六号线: "6号线",
    七号线: "7号线",
    八号线: "8号线",
    九号线: "9号线",
    十号线: "10号线"
  };
  return chineseNumbers[compact] ?? compact;
}

function countMatchedStations(recommendations: RankedHouse[], stations: string[]): number {
  const matched = new Set<string>();
  for (const house of recommendations) {
    const haystack = `${house.buildingName}${house.address ?? ""}`;
    const station = stations.find((candidate) => haystack.includes(candidate));
    if (station) {
      matched.add(station);
    }
  }
  return matched.size;
}

async function resolveStationCenters(
  dependencies: AssistantDependencies,
  stations: string[]
): Promise<Map<string, Coordinate>> {
  const centers = new Map<string, Coordinate>();
  for (const station of stations) {
    const center = await resolveConsultationCenter(dependencies, station);
    if (center) {
      centers.set(station, center);
    }
  }
  return centers;
}

function annotateMetroLineRecommendations(
  recommendations: RankedHouse[],
  houseStationMap: Map<string, string>,
  stationCenters: Map<string, Coordinate>
): RankedHouse[] {
  return recommendations
    .map((house) => {
      const station = houseStationMap.get(house.houseId) ?? findMatchedStation(house, Array.from(stationCenters.keys()));
      if (!station) {
        return house;
      }
      const center = stationCenters.get(station);
      const stationDistance =
        center && house.lng !== null && house.lat !== null
          ? distanceMeters(center, { lng: house.lng, lat: house.lat })
          : null;
      const stationText = stationDistance !== null ? `靠近${station}站，约${formatDistance(stationDistance)}` : `靠近${station}站`;
      return {
        ...house,
        distanceMeters: stationDistance ?? house.distanceMeters,
        recommendationReason: `${stationText}，${house.recommendationReason}`
      };
    })
    .sort((a, b) => compareDistanceThenScore(a, b));
}

function findMatchedStation(house: RankedHouse, stations: string[]): string | null {
  const haystack = `${house.buildingName}${house.address ?? ""}`;
  return stations.find((station) => haystack.includes(station)) ?? null;
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

function buildBuildingDetailReply(projectName: string, recommendations: RankedHouse[]): string {
  if (recommendations.length === 0) {
    return `${projectName}我这边暂时没查到空房，建议先确认项目/楼栋名称是否准确，或者我帮您查同商圈附近项目。`;
  }
  const lines = recommendations
    .slice(0, 4)
    .map((house, index) => `${index + 1}. ${house.houseNumber}，${house.bedroom}室${house.livingRoom}厅，${house.area}平，${house.rentPrice}元`);
  return `${projectName}目前有空房，户型覆盖 ${formatLayoutCoverage(recommendations)}，价格范围 ${formatPriceRange(recommendations)}。\n${lines.join("\n")}\n可以先按客户预算和户型挑最合适的发过去。`;
}

function buildFeatureInventoryReply(locationKeyword: string, feature: string, recommendations: RankedHouse[]): string {
  if (recommendations.length === 0) {
    return `${locationKeyword}暂时没查到明确满足“${feature}”的空房。可以先确认客户是否接受周边或换一个相近条件。`;
  }
  const lines = recommendations
    .slice(0, 4)
    .map((house, index) => `${index + 1}. ${house.buildingName} ${house.houseNumber}，${house.bedroom}室${house.livingRoom}厅，${house.area}平，${house.rentPrice}元，${house.recommendationReason || "可先核实房源详情"}`);
  return `${locationKeyword}我先按“${feature}”帮您筛了一版，查到 ${recommendations.length} 套可参考房源：\n${lines.join("\n")}\n这类条件建议发给客户前再点详情确认一次。`;
}

function buildCommuteReply(locationKeyword: string, destinationKeyword: string, recommendations: RankedHouse[]): string {
  if (recommendations.length === 0) {
    return `${locationKeyword}到${destinationKeyword}这条通勤需求暂时没有查到合适空房，可以换周边商圈或具体地铁站再查。`;
  }
  const lines = recommendations
    .slice(0, 4)
    .map((house, index) => `${index + 1}. ${house.buildingName} ${house.houseNumber}，${house.rentPrice}元，距离${destinationKeyword}${formatOptionalDistance(house.distanceMeters)}`);
  return `我按到${destinationKeyword}的距离给您排了一版，${locationKeyword}可参考这几套：\n${lines.join("\n")}\n实际通勤时间建议再结合地图路线确认。`;
}

function buildAreaInventoryReply(locationKeyword: string, recommendations: RankedHouse[]): string {
  if (recommendations.length === 0) {
    return `${locationKeyword}这边我暂时没看到合适空房。您方便的话可以告诉我预算和想看的户型，我再帮您往附近一起找找。`;
  }
  const rentPrices = recommendations.map((house) => house.rentPrice).filter((price) => price > 0);
  const priceText = rentPrices.length ? `，价格大概 ${Math.min(...rentPrices)}-${Math.max(...rentPrices)}元` : "";
  const lines = recommendations
    .slice(0, 5)
    .map((house, index) => `${index + 1}. ${house.buildingName} ${house.houseNumber}，${house.bedroom}室${house.livingRoom}厅，${house.area}平，${house.rentPrice}元`);
  return `${locationKeyword}目前有 ${recommendations.length} 套空房${priceText}，您可以看下这几套：\n${lines.join("\n")}\n如果您有预算或户型偏好，我再帮您筛到更合适的。`;
}

function buildMetroLineInventoryReply(lineName: string, recommendations: RankedHouse[]): string {
  if (recommendations.length === 0) {
    return `${lineName}沿线我暂时没看到合适空房。您可以补充预算、户型或更想靠近的站点，我再帮您重点找。`;
  }
  const rentPrices = recommendations.map((house) => house.rentPrice).filter((price) => price > 0);
  const priceText = rentPrices.length ? `，价格大概 ${Math.min(...rentPrices)}-${Math.max(...rentPrices)}元` : "";
  const lines = recommendations
    .slice(0, 5)
    .map((house, index) => `${index + 1}. ${house.buildingName} ${house.houseNumber}，${house.bedroom}室${house.livingRoom}厅，${house.area}平，${house.rentPrice}元，${house.recommendationReason}`);
  return `${lineName}沿线目前有 ${recommendations.length} 套空房${priceText}，您可以看下这几套：\n${lines.join("\n")}\n如果您更想靠近某个站点，我再帮您按站点距离筛一版。`;
}

function buildMetroStationInventoryReply(stationName: string, recommendations: RankedHouse[]): string {
  const stationLabel = `${stationName}站`;
  if (recommendations.length === 0) {
    return `${stationLabel}附近我暂时没看到合适空房。您可以补充预算和户型，我再帮您往前后几个站一起看看。`;
  }
  const rentPrices = recommendations.map((house) => house.rentPrice).filter((price) => price > 0);
  const priceText = rentPrices.length ? `，价格大概 ${Math.min(...rentPrices)}-${Math.max(...rentPrices)}元` : "";
  const lines = recommendations
    .slice(0, 5)
    .map((house, index) => `${index + 1}. ${house.buildingName} ${house.houseNumber}，${house.bedroom}室${house.livingRoom}厅，${house.area}平，${house.rentPrice}元，${house.recommendationReason}`);
  return `${stationLabel}附近目前有 ${recommendations.length} 套空房${priceText}，我按离地铁站近的优先排了：\n${lines.join("\n")}\n如果您有预算或户型要求，我再帮您筛到更精准。`;
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

function formatLayoutCoverage(recommendations: RankedHouse[]): string {
  const labels = Array.from(new Set(recommendations.map((house) => `${house.bedroom}室${house.livingRoom}厅`))).slice(0, 3);
  return labels.length ? labels.join("、") : "暂无";
}

function formatPriceRange(recommendations: RankedHouse[]): string {
  const prices = recommendations.map((house) => house.rentPrice).filter((price) => price > 0);
  return prices.length ? `${Math.min(...prices)}-${Math.max(...prices)}元` : "暂无";
}

function addConsultationFeature(requirement: RequirementExtraction, feature: string): RequirementExtraction {
  return validateRequirementExtraction({
    ...requirement,
    preferences: {
      ...requirement.preferences,
      features: Array.from(new Set([...(requirement.preferences.features ?? []), feature]))
    }
  });
}

function extractFeatureIntent(message: string): string | null {
  if (/可养宠物|可以养宠物|能养宠物|允许养宠物|宠物友好|养猫|养狗|带宠物/.test(message)) return "可养宠物";
  if (/阳台|带阳台|有阳台/.test(message)) return "带阳台";
  if (/电梯|有电梯|电梯房/.test(message)) return "电梯房";
  if (/近地铁|靠近地铁|地铁口|离地铁近/.test(message)) return "近地铁";
  return null;
}

function extractPaymentIntent(message: string): string | null {
  if (/押一付一|押1付1/.test(message)) return "押一付一";
  if (/月付|按月付/.test(message)) return "月付";
  if (/押金|付款方式|怎么付/.test(message)) return "付款方式";
  return null;
}

function extractMoveInDate(message: string): string | null {
  if (/随时入住|马上入住/.test(message)) return "随时入住";
  if (/本周入住/.test(message)) return "本周入住";
  if (/月底入住/.test(message)) return "月底入住";
  if (/近期入住/.test(message)) return "近期入住";
  return null;
}

function formatDistance(distance: number): string {
  if (distance < 1000) return `${Math.round(distance)}米`;
  return `${(distance / 1000).toFixed(1)}公里`;
}

function formatOptionalDistance(distance: number | null | undefined): string {
  return distance === null || distance === undefined ? "待确认" : formatDistance(distance);
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
  return /周边可以|附近也行|附近可以|可以周边|周边也行|预算.*上浮|上浮.*预算/.test(message.trim());
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
    pageSize: mcpPageSize,
    maxResults: consultationMaxResults
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
      pageSize: mcpPageSize,
      maxResults: consultationMaxResults
    };
    const geo = await callGeoSearch(dependencies, sessionId, "geo_radius_fallback", geoArgs);
    trace.push({ name: "geo_radius_fallback", arguments: omitEmptyArgs(geoArgs), resultCount: geo.length });
    if (strict.length + geo.length > 0) {
      return { houses: uniqueHouses([...strict, ...geo]), searchTrace: trace };
    }
  }

  const fallbackArgs = {
    keyword: requirement.location?.district?.replace("区", "") ?? requirement.location?.normalized,
    bedroom: requirement.layout.bedroom,
    livingRoom: requirement.layout.livingRoom,
    minRent: budget.min,
    maxRent: budget.max,
    status: 0,
    pageSize: mcpPageSize,
    maxResults: consultationMaxResults
  };
  const fallback = await callSearch(dependencies, sessionId, "district_fallback", fallbackArgs);
  trace.push({ name: "district_fallback", arguments: omitEmptyArgs(fallbackArgs), resultCount: fallback.length });
  if (strict.length + fallback.length > 0) {
    return { houses: uniqueHouses([...strict, ...fallback]), searchTrace: trace };
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
    return { houses: uniqueHouses([...strict, ...fallback, ...budgetFallback]), searchTrace: trace };
  }

  const inventoryBudgetFallbackArgs = {
    bedroom: requirement.layout.bedroom,
    livingRoom: requirement.layout.livingRoom,
    minRent: budget.min,
    maxRent: expandedBudget.max,
    status: 0,
    pageSize: mcpPageSize,
    maxResults: consultationMaxResults
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
    houses: uniqueHouses([...strict, ...fallback, ...budgetFallback, ...inventoryBudgetFallback]),
    searchTrace: trace
  };
}

function uniqueHouses(houses: House[]): House[] {
  return Array.from(new Map(houses.map((house) => [house.houseId, house])).values());
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

  return mapWithConcurrency(recommendations, imageEnrichmentConcurrency, async (house) => {
    if (house.coverImageUrl) return house;
    try {
      const [coverImageUrl] = await dependencies.mcpClient.getHouseImageUrlsSafe?.(house.houseId) ?? [];
      return { ...house, coverImageUrl: coverImageUrl ?? null };
    } catch {
      return { ...house, coverImageUrl: null };
    }
  });
}

async function enrichRecommendationImages(
  dependencies: AssistantDependencies,
  recommendations: RankedHouse[],
  options: { prioritizeImages?: boolean } = {}
): Promise<RankedHouse[]> {
  if (dependencies.enrichImages === false) {
    return recommendations;
  }
  const enrichedRecommendations = await enrichRecommendationsWithImages(dependencies, recommendations);
  return options.prioritizeImages === false
    ? enrichedRecommendations
    : prioritizeImageBackedRecommendations(enrichedRecommendations);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function prioritizeImageBackedRecommendations(recommendations: RankedHouse[]): RankedHouse[] {
  return recommendations
    .map((house, index) => ({ house, index }))
    .sort((a, b) => {
      const aHasImage = Boolean(a.house.coverImageUrl);
      const bHasImage = Boolean(b.house.coverImageUrl);
      if (aHasImage !== bHasImage) return aHasImage ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ house }) => house);
}

function applyCustomerProfileRanking(
  recommendations: RankedHouse[],
  requirement: RequirementExtraction,
  customerProfile: CustomerProfile | null
): RankedHouse[] {
  if (!customerProfile) {
    return recommendations;
  }
  return recommendations
    .map((house, index) => ({ house, index }))
    .sort((a, b) => {
      const profileScoreDiff =
        getCustomerProfileScore(b.house, requirement, customerProfile) -
        getCustomerProfileScore(a.house, requirement, customerProfile);
      if (profileScoreDiff !== 0) return profileScoreDiff;
      return a.index - b.index;
    })
    .map(({ house }) => house);
}

function getCustomerProfileScore(
  house: RankedHouse,
  requirement: RequirementExtraction,
  customerProfile: CustomerProfile
): number {
  let score = 0;
  if (customerProfile.distanceSensitive && house.distanceMeters !== null) {
    score += Math.max(0, 20 - Math.floor(house.distanceMeters / 300));
  }
  if (
    customerProfile.budgetSensitive &&
    requirement.budget &&
    house.rentPrice >= requirement.budget.min &&
    house.rentPrice <= requirement.budget.max
  ) {
    score += 18;
  }
  if (customerProfile.layoutStrict && requirement.layout.bedroom !== null && house.bedroom === requirement.layout.bedroom) {
    score += 16;
  }
  if (customerProfile.needsImages && house.coverImageUrl) {
    score += 12;
  }
  return score;
}

function buildSalesReply(
  requirement: RequirementExtraction,
  recommendations: RankedHouse[],
  searchTrace: SearchTraceStep[],
  customerProfile: CustomerProfile | null = null
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
  const profileHint = buildCustomerProfileReplyHint(customerProfile);
  const lines = recommendations
    .slice(0, 3)
    .map(
      (house, index) =>
        `${index + 1}. ${house.buildingName}-${house.houseNumber}，${house.bedroom}室${house.livingRoom}厅，${house.area}平，租金${house.rentPrice}元，${house.recommendationReason}`
    );

  return {
    text: `${prefix}${profileHint ? `\n${profileHint}` : ""}\n${lines.join("\n")}\n您看我先发两套最接近的给客户确认吗？`,
    nextAction: "copy_reply"
  };
}

function buildCustomerProfileReplyHint(customerProfile: CustomerProfile | null): string | null {
  if (!customerProfile) return null;
  const hints: string[] = [];
  if (customerProfile.distanceSensitive) hints.push("客户之前比较在意位置距离，这次我优先把近的排前面");
  if (customerProfile.budgetSensitive) hints.push("客户之前比较在意价格，这次我优先保留预算内房源");
  if (customerProfile.layoutStrict) hints.push("客户之前对户型比较严格，这次优先看户型一致的");
  if (customerProfile.needsImages) hints.push("客户之前比较在意图片，这次优先展示有图房源");
  if (customerProfile.decorationSensitive) hints.push("客户之前比较在意装修，建议点详情确认实拍和配置");
  return hints.length ? hints.join("；") + "。" : null;
}

function formatRequirementLayout(requirement: RequirementExtraction): string {
  const bedroom = requirement.layout.bedroom === null ? "" : `${requirement.layout.bedroom}室`;
  const livingRoom = requirement.layout.livingRoom === null ? "" : `${requirement.layout.livingRoom}厅`;
  return bedroom || livingRoom ? `${bedroom}${livingRoom}` : "目标户型";
}
