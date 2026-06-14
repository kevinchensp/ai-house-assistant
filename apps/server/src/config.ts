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
    amapCity: env.AMAP_CITY ?? "广州"
  };
}
