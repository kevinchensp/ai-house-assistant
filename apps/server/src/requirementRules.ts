import {
  type RequirementExtraction,
  parseBudgetAround,
  resolveLocation,
  validateRequirementExtraction
} from "@ai-house-assistant/shared";

export function extractRequirementByRules(message: string): RequirementExtraction {
  const location = message.match(/东平|白云大道北|天瑞广场|石井|龙归|白云/) ? resolveLocation(message) : null;
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
      moveInDate: null,
      features: extractFeatures(message)
    },
    missingRequiredSlots,
    shouldAskFollowUp: missingRequiredSlots.length > 0,
    followUpQuestion:
      missingRequiredSlots.length > 0 ? "请问客户主要想看哪个区域、预算大概多少，以及户型要求是什么？" : null
  });
}

function extractFeatures(message: string): string[] {
  const features: string[] = [];
  if (/近地铁|靠近地铁|地铁站|地铁口|离地铁近/.test(message)) features.push("近地铁");
  if (/阳台|带阳台|有阳台/.test(message)) features.push("带阳台");
  if (/大单间|大一点|大点|面积大|空间大/.test(message)) features.push("大单间");
  return features;
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
