export type ServerConfig = {
  port: number;
  mcpServerUrl: string | null;
  mcpAuthToken: string | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 3101),
    mcpServerUrl: env.MCP_SERVER_URL ?? null,
    mcpAuthToken: env.MCP_AUTH_TOKEN ?? null
  };
}
