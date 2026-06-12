import type { RankedHouse, RequirementExtraction, SalesReply, SearchPlan } from "@ai-house-assistant/shared";

export type LlmProvider = {
  extractRequirement(input: string, context?: Record<string, unknown>): Promise<RequirementExtraction>;
  generateSearchPlan(requirement: RequirementExtraction): Promise<SearchPlan>;
  generateRecommendation(requirement: RequirementExtraction, houses: RankedHouse[]): Promise<RankedHouse[]>;
  generateSalesReply(requirement: RequirementExtraction, recommendations: RankedHouse[]): Promise<SalesReply>;
};

export class MockLlmProvider implements Pick<LlmProvider, "generateSalesReply"> {
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
