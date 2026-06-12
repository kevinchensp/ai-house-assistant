import {
  type Budget,
  type Coordinate,
  type House,
  type RankedHouse,
  type RequirementExtraction,
  parseBudgetAround,
  rankHouses,
  resolveLocation,
  validateRequirementExtraction
} from "@ai-house-assistant/shared";
import type { InMemoryEventLogger } from "./eventLogger";

export type AssistantMcpClient = {
  searchHouses(args: Record<string, unknown>): Promise<House[]>;
};

export type AssistantDependencies = {
  mcpClient: AssistantMcpClient;
  eventLogger: InMemoryEventLogger;
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
  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      dependencies.eventLogger.record("message_sent", {
        sessionId: request.sessionId,
        payload: { text: request.message }
      });

      const requirement = extractRequirement(request.message);
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

function extractRequirement(message: string): RequirementExtraction {
  const location = message.match(/东平|白云大道北|天瑞广场|石井|白云/) ? resolveLocation(message) : null;
  const budget = parseBudgetAround(message);
  const bedroom = extractBedroom(message);
  const livingRoom = extractLivingRoom(message);
  const layout = {
    bedroom,
    livingRoom,
    toilet: null,
    confidence: bedroom !== null ? 0.9 : 0.3
  };

  const missingRequiredSlots: string[] = [];
  if (!location || location.confidence < 0.5) missingRequiredSlots.push("location");
  if (!budget) missingRequiredSlots.push("budget");
  if (layout.bedroom === null) missingRequiredSlots.push("layout");

  return validateRequirementExtraction({
    location,
    budget,
    layout,
    preferences: {
      rentType: null,
      direction: null,
      minArea: null,
      moveInDate: null
    },
    missingRequiredSlots,
    shouldAskFollowUp: missingRequiredSlots.length > 0,
    followUpQuestion:
      missingRequiredSlots.length > 0 ? "请问客户主要想看哪个区域、预算大概多少，以及户型要求是什么？" : null
  });
}

function extractBedroom(message: string): number | null {
  if (/一居室|一房|一室|1室|1房|单间/.test(message)) {
    return 1;
  }
  if (/两居室|两房|二室|2室|2房/.test(message)) {
    return 2;
  }
  if (/三居室|三房|三室|3室|3房/.test(message)) {
    return 3;
  }
  return null;
}

function extractLivingRoom(message: string): number | null {
  if (/一厅|1厅/.test(message)) {
    return 1;
  }
  if (/两厅|二厅|2厅/.test(message)) {
    return 2;
  }
  if (/单间|一居室|一房/.test(message)) {
    return 0;
  }
  return null;
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
  trace.push({ name: "strict_keyword", arguments: strictArgs, resultCount: strict.length });
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
  trace.push({ name: "district_fallback", arguments: fallbackArgs, resultCount: fallback.length });
  return { houses: withFallbackCoordinates([...strict, ...fallback], center), searchTrace: trace };
}

async function callSearch(
  dependencies: AssistantDependencies,
  sessionId: string,
  name: string,
  args: Record<string, unknown>
): Promise<House[]> {
  dependencies.eventLogger.record("mcp_called", { sessionId, payload: { name, args } });
  try {
    return await dependencies.mcpClient.searchHouses(args);
  } catch (error) {
    dependencies.eventLogger.record("mcp_failed", {
      sessionId,
      payload: { name, message: error instanceof Error ? error.message : String(error) }
    });
    return [];
  }
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
  const prefix = strictHadResults
    ? `${requirement.location?.normalized ?? "目标位置"}附近有几套比较匹配的房源。`
    : `${requirement.location?.normalized ?? "目标位置"}附近暂时没看到完全匹配的一室一厅 ${requirement.budget?.target ?? ""} 左右房源，我帮您往周边扩大了一圈。`;
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
