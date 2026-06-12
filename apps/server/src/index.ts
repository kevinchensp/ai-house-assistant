import cors from "cors";
import { config as loadDotenv } from "dotenv";
import express from "express";
import { createAssistant } from "./assistant";
import { loadConfig } from "./config";
import { InMemoryEventLogger } from "./eventLogger";
import { MockLlmProvider } from "./llmProvider";
import { McpClient } from "./mcpClient";
import { MockMcpClient } from "./mockMcpClient";

loadDotenv({ path: new URL("../../../.env", import.meta.url) });

const config = loadConfig();
const app = express();
const eventLogger = new InMemoryEventLogger();
const mcpClient =
  config.mcpServerUrl && config.mcpAuthToken
    ? new McpClient({ url: config.mcpServerUrl, authToken: config.mcpAuthToken })
    : new MockMcpClient();
const assistant = createAssistant({ mcpClient, eventLogger, llmProvider: new MockLlmProvider() });

app.use(cors());
app.use(express.json());

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    mcpMode: config.mcpServerUrl && config.mcpAuthToken ? "remote" : "mock"
  });
});

app.post("/api/ai-house-assistant/chat", async (request, response, next) => {
  try {
    const message = String(request.body?.message ?? "");
    const sessionId = String(request.body?.sessionId ?? crypto.randomUUID());
    if (!message.trim()) {
      response.status(400).json({ error: "message is required" });
      return;
    }

    const result = await assistant.chat({ sessionId, message });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/ai-house-assistant/events", (_request, response) => {
  response.json({ events: eventLogger.all() });
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(500).json({
    error: error instanceof Error ? error.message : "internal server error"
  });
});

app.listen(config.port, () => {
  console.log(`AI house assistant API listening on http://localhost:${config.port}`);
});
