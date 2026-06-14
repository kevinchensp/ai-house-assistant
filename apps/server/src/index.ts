import cors from "cors";
import { config as loadDotenv } from "dotenv";
import express from "express";
import { LocationSchema } from "@ai-house-assistant/shared";
import { createAssistant } from "./assistant";
import type { ChatResponse } from "./assistant";
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
const assistant = createAssistant({ mcpClient, eventLogger, llmProvider, locationResolver });

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
    const result = await assistant.chat({ sessionId, message, clientResolvedLocation });
    await store.saveAssistantResult(userId, sessionId, result, buildAssistantMessage(result));
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/ai-house-assistant/events", (_request, response) => {
  response.json({ events: eventLogger.all() });
});

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
  if (result.consultation) {
    return `${result.consultation.summary} 右侧已整理查询结果和可复制话术。`;
  }
  const traceText = result.searchTrace
    .map((step) => `${step.name === "strict_keyword" ? "精确匹配" : "周边扩圈"} ${step.resultCount} 套`)
    .join("，");
  const topHouse = result.recommendations[0];
  if (!topHouse) {
    return "这组条件暂时没找到合适房源。我建议先问客户是否能接受周边位置或预算上浮。";
  }
  return `我查完了：${traceText}。优先推荐 ${topHouse.buildingName} ${topHouse.houseNumber}，${topHouse.bedroom}室${topHouse.livingRoom}厅，租金${topHouse.rentPrice}元。右侧已经整理好推荐卡片和可复制话术。`;
}
