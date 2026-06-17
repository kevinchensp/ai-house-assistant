import cors from "cors";
import { config as loadDotenv } from "dotenv";
import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocationSchema, type RankedHouse } from "@ai-house-assistant/shared";
import { createAssistant } from "./assistant";
import type { ChatResponse, RecommendationPagination } from "./assistant";
import { JsonAppStore, toPublicUser } from "./appStore";
import { AuthService, requireAdminUser, requireUserId } from "./auth";
import { BailianLlmProvider } from "./bailianLlmProvider";
import { loadConfig } from "./config";
import { InMemoryEventLogger } from "./eventLogger";
import { AmapLocationResolver } from "./locationResolver";
import { MockLlmProvider } from "./llmProvider";
import { McpClient } from "./mcpClient";
import { MockMcpClient } from "./mockMcpClient";

loadDotenv({ path: new URL("../../../.env", import.meta.url) });

const config = loadConfig();
const app = express();
const eventLogger = new InMemoryEventLogger();
const store = new JsonAppStore(config.appDataPath);
await store.ensureAdminUser();
const authService = new AuthService(store);
const mcpClient =
  config.mcpServerUrl && config.mcpAuthToken
    ? new McpClient({ url: config.mcpServerUrl, authToken: config.mcpAuthToken })
    : new MockMcpClient();
const llmProvider = config.bailianApiKey
  ? new BailianLlmProvider({
      apiKey: config.bailianApiKey,
      baseUrl: config.bailianBaseUrl,
      model: config.bailianModel
    })
  : new MockLlmProvider();
const locationResolver = config.amapWebServiceKey
  ? new AmapLocationResolver({ apiKey: config.amapWebServiceKey, city: config.amapCity })
  : undefined;
const assistant = createAssistant({ mcpClient, eventLogger, llmProvider, locationResolver, enrichImages: false });
const recommendationPageSize = 10;
const maxRecommendationPageSize = 20;
const pageImageEnrichmentConcurrency = 3;

app.use(cors());
app.use(express.json());

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    mcpMode: config.mcpServerUrl && config.mcpAuthToken ? "remote" : "mock",
    llmMode: config.bailianApiKey ? "bailian" : "mock",
    llmModel: config.bailianApiKey ? config.bailianModel : "local-mock",
    locationMode: config.amapWebServiceKey ? "amap" : "local"
  });
});

app.post("/api/auth/login", async (request, response, next) => {
  try {
    const phone = String(request.body?.phone ?? "");
    const password = String(request.body?.password ?? "");
    if (!phone.trim() || !password) {
      response.status(400).json({ error: "phone and password are required" });
      return;
    }

    response.json(await authService.login(phone, password));
  } catch (error) {
    next(error);
  }
});

app.get("/api/me", async (request, response, next) => {
  try {
    const userId = requireUserId(request, authService);
    response.json({ user: toPublicUser(await store.getUser(userId)) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/users", async (request, response, next) => {
  try {
    await requireAdminUser(request, authService, store);
    response.json({ users: (await store.listUsers()).map(toPublicUser) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/users", async (request, response, next) => {
  try {
    await requireAdminUser(request, authService, store);
    const name = String(request.body?.name ?? "");
    const phone = String(request.body?.phone ?? "");
    const password = String(request.body?.password ?? "");
    const user = await store.createUser({ name, phone, password, role: "agent" });
    response.status(201).json({ user: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/customer-sessions", async (request, response, next) => {
  try {
    const userId = requireUserId(request, authService);
    response.json({ sessions: await store.listCustomerSessions(userId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/customer-sessions", async (request, response, next) => {
  try {
    const userId = requireUserId(request, authService);
    const customerName = String(request.body?.customerName ?? "");
    response.json({ session: await store.createCustomerSession(userId, customerName) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/customer-sessions/:sessionId", async (request, response, next) => {
  try {
    const userId = requireUserId(request, authService);
    const customerName = String(request.body?.customerName ?? "");
    response.json({ session: await store.renameCustomerSession(userId, request.params.sessionId, customerName) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai-house-assistant/chat", async (request, response, next) => {
  try {
    const userId = requireUserId(request, authService);
    const message = String(request.body?.message ?? "");
    const sessionId = String(request.body?.sessionId ?? crypto.randomUUID());
    if (!message.trim()) {
      response.status(400).json({ error: "message is required" });
      return;
    }

    await store.getCustomerSession(userId, sessionId);
    await store.addMessage(userId, sessionId, "user", message);
    const clientResolvedLocation = LocationSchema.nullable()
      .optional()
      .catch(undefined)
      .parse(request.body?.clientResolvedLocation);
    const fullResult = await assistant.chat({ sessionId, message, clientResolvedLocation });
    const result = await withRecommendationPage(fullResult, 1, recommendationPageSize);
    await store.saveAssistantResult(userId, sessionId, result, buildAssistantMessage(result), fullResult.recommendations);
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/customer-sessions/:sessionId/recommendations", async (request, response, next) => {
  try {
    const userId = requireUserId(request, authService);
    const session = await store.getCustomerSession(userId, request.params.sessionId);
    if (!session.latestResponse) {
      response.status(404).json({ error: "recommendations not found" });
      return;
    }

    const page = Number(request.query.page ?? 1);
    const pageSize = Number(request.query.pageSize ?? recommendationPageSize);
    const pool = session.latestRecommendationPool ?? session.latestResponse.recommendations;
    const pageResult = await paginateRecommendations(pool, page, pageSize);
    response.json(pageResult);
  } catch (error) {
    next(error);
  }
});

app.get("/api/ai-house-assistant/events", (_request, response) => {
  response.json({ events: eventLogger.all() });
});

const webDistPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDistPath)) {
  app.use(express.static(webDistPath));
  app.get(/^\/(?!api\/).*/, (_request, response) => {
    response.sendFile(path.join(webDistPath, "index.html"));
  });
}

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const status = error instanceof Error && "status" in error ? Number((error as Error & { status: number }).status) : 500;
  response.status(Number.isFinite(status) ? status : 500).json({
    error: error instanceof Error ? error.message : "internal server error"
  });
});

app.listen(config.port, () => {
  console.log(`AI house assistant API listening on http://localhost:${config.port}`);
});

function buildAssistantMessage(result: ChatResponse): string {
  if (result.followUpQuestion) {
    return result.followUpQuestion;
  }
  return result.salesReply.text;
}

async function withRecommendationPage(result: ChatResponse, page: number, pageSize: number): Promise<ChatResponse> {
  const pageResult = await paginateRecommendations(result.recommendations, page, pageSize);
  return {
    ...result,
    recommendations: pageResult.recommendations,
    recommendationPagination: pageResult.recommendationPagination
  };
}

async function paginateRecommendations(
  recommendations: ChatResponse["recommendations"],
  page: number,
  pageSize: number
): Promise<{ recommendations: ChatResponse["recommendations"]; recommendationPagination: RecommendationPagination }> {
  const safePageSize = clampInteger(pageSize, 1, maxRecommendationPageSize, recommendationPageSize);
  const total = recommendations.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = clampInteger(page, 1, totalPages, 1);
  const start = (safePage - 1) * safePageSize;
  const pageRecommendations = await enrichPageRecommendationImages(recommendations.slice(start, start + safePageSize));

  return {
    recommendations: pageRecommendations,
    recommendationPagination: {
      page: safePage,
      pageSize: safePageSize,
      total,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1
    }
  };
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

async function enrichPageRecommendationImages(recommendations: RankedHouse[]): Promise<RankedHouse[]> {
  if (!("getHouseImageUrlsSafe" in mcpClient) || typeof mcpClient.getHouseImageUrlsSafe !== "function") {
    return recommendations;
  }

  const enrichedRecommendations = await mapWithConcurrency(recommendations, pageImageEnrichmentConcurrency, async (house) => {
    if (house.coverImageUrl) return house;
    try {
      const [coverImageUrl] = await mcpClient.getHouseImageUrlsSafe(house.houseId);
      return { ...house, coverImageUrl: coverImageUrl ?? null };
    } catch {
      return { ...house, coverImageUrl: null };
    }
  });
  return prioritizeImageBackedRecommendations(enrichedRecommendations);
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
