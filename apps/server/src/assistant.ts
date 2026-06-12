import {
  type Budget,
  type Coordinate,
  type House,
  type RankedHouse,
  type RequirementExtraction,
  rankHouses,
  validateRequirementExtraction
} from "@ai-house-assistant/shared";
import type { InMemoryEventLogger } from "./eventLogger";
import type { RequirementExtractionProvider } from "./llmProvider";
import { extractRequirementByRules } from "./requirementRules";

export type AssistantMcpClient = {
  searchHouses(args: Record<string, unknown>): Promise<House[]>;
};

export type AssistantDependencies = {
  mcpClient: AssistantMcpClient;
  eventLogger: InMemoryEventLogger;
  llmProvider?: RequirementExtractionProvider;
};

export type ChatRequest = {
  sessionId: string;
  message: string;
};

export type SearchTraceStep = {
  name: string;
  arguments: Record<string, unknown>;
  resultCount: number;
};

export type ChatResponse = {
  sessionId: string;
  requirement: RequirementExtraction;
  followUpQuestion: string | null;
  searchTrace: SearchTraceStep[];
  recommendations: RankedHouse[];
  salesReply: {
    text: string;
    nextAction: string;
  };
};

export function createAssistant(dependencies: AssistantDependencies) {
  const sessionState = new Map<string, RequirementExtraction>();

  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      dependencies.eventLogger.record("message_sent", {
        sessionId: request.sessionId,
        payload: { text: request.message }
      });

      const priorRequirement = sessionState.get(request.sessionId) ?? null;
      const requirement = await resolveTurnRequirement(dependencies, request.message, priorRequirement);
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
          salesReply: {
            text: requirement.followUpQuestion ?? "我再确认一下客户的区域和预算后帮您找。",
            nextAction: "ask_follow_up"
          }
        };
      }

      sessionState.set(request.sessionId, requirement);

      const { houses, searchTrace } = await searchWithFallbacks(dependencies, request.sessionId, requirement);
      const recommendations = rankHouses(houses, {
        budget: requirement.budget,
        layout: requirement.layout,
        center: requirement.location?.center ?? null
      }).slice(0, 5);

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
        requirement,
        followUpQuestion: null,
        searchTrace,
        recommendations,
        salesReply
      };
    }
  };
}

async function resolveTurnRequirement(
  dependencies: AssistantDependencies,
  message: string,
  priorRequirement: RequirementExtraction | null
): Promise<RequirementExtraction> {
  if (priorRequirement && isNearbyAcceptance(message)) {
    return widenRequirementForNearby(priorRequirement, { widenBudget: isBudgetWidening(message) });
  }
  return extractRequirementWithFallback(dependencies, message);
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
    return { houses: withFallbackCoordinates(strict, center), searchTrace: trace };
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
    return { houses: withFallbackCoordinates([...strict, ...fallback], center), searchTrace: trace };
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
    return { houses: withFallbackCoordinates([...strict, ...fallback, ...budgetFallback], center), searchTrace: trace };
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
    houses: withFallbackCoordinates([...strict, ...fallback, ...budgetFallback, ...inventoryBudgetFallback], center),
    searchTrace: trace
  };
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

function omitEmptyArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null && value !== undefined));
}

function withFallbackCoordinates(houses: House[], center: Coordinate | null): House[] {
  return houses.map((house) => ({
    ...house,
    lng: house.lng ?? center?.lng ?? null,
    lat: house.lat ?? center?.lat ?? null
  }));
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
