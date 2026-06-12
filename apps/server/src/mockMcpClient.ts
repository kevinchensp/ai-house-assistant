import type { House } from "@ai-house-assistant/shared";
import type { AssistantMcpClient } from "./assistant";

const DEMO_HOUSES: House[] = [
  {
    houseId: "1978",
    buildingId: "37",
    buildingName: "白心公寓12",
    houseNumber: "110",
    rentPrice: 1000,
    deposit: 1000,
    bedroom: 1,
    livingRoom: 1,
    toilet: 1,
    area: 60,
    direction: "",
    status: 0,
    updatedAt: "2026-06-11T16:21:58.000Z",
    lng: 113.29748,
    lat: 23.222149
  },
  {
    houseId: "2296",
    buildingId: "191",
    buildingName: "白云3号公寓",
    houseNumber: "704",
    rentPrice: 1200,
    deposit: 2400,
    bedroom: 1,
    livingRoom: 1,
    toilet: 1,
    area: 50,
    direction: "",
    status: 0,
    updatedAt: "2025-04-18T14:43:32.000Z",
    lng: 113.29748,
    lat: 23.222149
  }
];

export class MockMcpClient implements AssistantMcpClient {
  async searchHouses(args: Record<string, unknown>): Promise<House[]> {
    if (args.keyword === "东平") {
      return [];
    }
    return DEMO_HOUSES.filter((house) => {
      const bedroomMatches = args.bedroom === undefined || house.bedroom === Number(args.bedroom);
      const livingRoomMatches = args.livingRoom === undefined || house.livingRoom === Number(args.livingRoom);
      const minRentMatches = args.minRent === undefined || house.rentPrice >= Number(args.minRent);
      const maxRentMatches = args.maxRent === undefined || house.rentPrice <= Number(args.maxRent);
      return bedroomMatches && livingRoomMatches && minRentMatches && maxRentMatches;
    });
  }
}
