import {
  type RankedHouse,
  type RequirementExtraction,
  type SalesReply,
  type SearchPlan,
  parseBudgetAround,
  resolveLocation,
  validateRequirementExtraction
} from "@ai-house-assistant/shared";
import { extractRequirementByRules } from "./requirementRules";

export type AssistantIntent =
  | { type: "recommend_houses"; confidence: number }
  | { type: "project_vacancy"; projectName: string; confidence: number }
  | { type: "area_inventory"; locationKeyword: string; confidence: number }
  | { type: "metro_line_inventory"; lineName: string; confidence: number }
  | { type: "metro_station_inventory"; stationName: string; lineName: string | null; confidence: number }
  | {
      type: "area_layout_availability";
      locationKeyword: string;
      layout: { bedroom: number | null; livingRoom: number | null };
      confidence: number;
    }
  | {
      type: "price_range";
      locationKeyword: string;
      layout: { bedroom: number | null; livingRoom: number | null };
      confidence: number;
    }
  | { type: "distance_ranking"; locationKeyword: string; confidence: number };

export type RequirementExtractionProvider = Pick<LlmProvider, "extractRequirement"> & {
  extractAssistantIntent?: (input: string, context?: Record<string, unknown>) => Promise<AssistantIntent>;
};

export type LlmProvider = {
  extractAssistantIntent(input: string, context?: Record<string, unknown>): Promise<AssistantIntent>;
  extractRequirement(input: string, context?: Record<string, unknown>): Promise<RequirementExtraction>;
  generateSearchPlan(requirement: RequirementExtraction): Promise<SearchPlan>;
  generateRecommendation(requirement: RequirementExtraction, houses: RankedHouse[]): Promise<RankedHouse[]>;
  generateSalesReply(requirement: RequirementExtraction, recommendations: RankedHouse[]): Promise<SalesReply>;
};

export class MockLlmProvider implements Pick<LlmProvider, "generateSalesReply"> {
  async extractRequirement(input: string): Promise<RequirementExtraction> {
    const ruleResult = extractRequirementByRules(input);
    const inferredBudget = inferBudget(input) ?? ruleResult.budget;
    const inferredLayout = inferLayout(input) ?? ruleResult.layout;
    const inferredLocation = inferLocation(input) ?? ruleResult.location;

    const missingRequiredSlots: string[] = [];
    if (!inferredLocation || inferredLocation.confidence < 0.5) missingRequiredSlots.push("location");
    if (!inferredBudget) missingRequiredSlots.push("budget");
    if (inferredLayout.bedroom === null) missingRequiredSlots.push("layout");

    return validateRequirementExtraction({
      ...ruleResult,
      location: inferredLocation,
      budget: inferredBudget,
      layout: inferredLayout,
      missingRequiredSlots,
      shouldAskFollowUp: missingRequiredSlots.length > 0,
      followUpQuestion:
        missingRequiredSlots.length > 0 ? "请问客户主要想看哪个区域、预算大概多少，以及户型要求是什么？" : null
    });
  }

  async generateSalesReply(_requirement: RequirementExtraction, recommendations: RankedHouse[]): Promise<SalesReply> {
    if (recommendations.length === 0) {
      return {
        text: "当前条件暂时没看到合适房源，建议先确认客户是否接受周边位置或预算上浮。",
        nextAction: "ask_customer_flexibility"
      };
    }

    return {
      text: recommendations
        .slice(0, 3)
        .map((house, index) => `${index + 1}. ${house.buildingName}-${house.houseNumber}，租金${house.rentPrice}元`)
        .join("\n"),
      nextAction: "copy_reply"
    };
  }
}

function inferBudget(input: string): RequirementExtraction["budget"] {
  if (/便宜点|便宜|低价|实惠/.test(input)) {
    const explicit = parseBudgetAround(input);
    return explicit ?? { target: 900, min: 0, max: 900, confidence: 0.72 };
  }
  if (/以内|不超过|别超过/.test(input)) {
    const match = input.match(/(\d{3,5})/);
    if (match) {
      const max = Number(match[1]);
      return { target: max, min: 0, max, confidence: 0.84 };
    }
  }
  return null;
}

function inferLayout(input: string): RequirementExtraction["layout"] | null {
  if (/一房|一居|一居室|单间/.test(input)) {
    return { bedroom: 1, livingRoom: /单间|一居|一居室/.test(input) ? 0 : null, toilet: null, confidence: 0.82 };
  }
  return null;
}

function inferLocation(input: string): RequirementExtraction["location"] {
  const match = input.match(/(东平|石井|天瑞广场|白云大道北)/);
  return match ? resolveLocation(match[1] ?? input) : null;
}
