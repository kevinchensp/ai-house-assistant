export type ServerConfig = {
  port: number;
  mcpServerUrl: string | null;
  mcpAuthToken: string | null;
  bailianApiKey: string | null;
  bailianBaseUrl: string;
  bailianModel: string;
  appDataPath: string;
  amapWebServiceKey: string | null;
  amapCity: string;
  adminInitialPassword: string | null;
  authTokenTtlMs: number;
  corsOrigin: string | null;
  mcpTimeoutMs: number;
  bailianTimeoutMs: number;
  amapTimeoutMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 3101),
    mcpServerUrl: env.MCP_SERVER_URL ?? null,
    mcpAuthToken: env.MCP_AUTH_TOKEN ?? null,
    bailianApiKey: env.BAILIAN_API_KEY ?? null,
    bailianBaseUrl: env.BAILIAN_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    bailianModel: env.BAILIAN_MODEL ?? "qwen-plus",
    appDataPath: env.APP_DATA_PATH ?? ".data/ai-house-assistant.json",
    amapWebServiceKey: env.AMAP_WEB_SERVICE_KEY ?? null,
    amapCity: env.AMAP_CITY ?? "广州",
    adminInitialPassword: env.ADMIN_INITIAL_PASSWORD ?? null,
    authTokenTtlMs: toPositiveNumber(env.AUTH_TOKEN_TTL_MS, 8 * 60 * 60 * 1000),
    corsOrigin: env.CORS_ORIGIN ?? null,
    mcpTimeoutMs: toPositiveNumber(env.MCP_TIMEOUT_MS, 12000),
    bailianTimeoutMs: toPositiveNumber(env.BAILIAN_TIMEOUT_MS, 15000),
    amapTimeoutMs: toPositiveNumber(env.AMAP_TIMEOUT_MS, 5000)
  };
}

function toPositiveNumber(value: string | undefined, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}
