import { readFile, writeFile } from "node:fs/promises";

const mode = process.argv[2];
const allowedModes = new Set(["local", "remote"]);

if (!allowedModes.has(mode)) {
  console.error("Usage: npm run mcp:local | npm run mcp:remote");
  process.exit(1);
}

const envPath = new URL("../.env", import.meta.url);
const envText = await readFile(envPath, "utf8").catch((error) => {
  if (error?.code === "ENOENT") {
    console.error(".env not found. Copy .env.example to .env first.");
    process.exit(1);
  }
  throw error;
});

const lines = envText.split(/\r?\n/);
const values = parseEnv(lines);
const prefix = mode === "local" ? "MCP_LOCAL" : "MCP_REMOTE";
const nextUrl = values[`${prefix}_SERVER_URL`] ?? (mode === "local" ? "http://127.0.0.1:3100/mcp" : null);
const nextToken = values[`${prefix}_AUTH_TOKEN`];

if (!nextUrl || !nextToken) {
  console.error(`Missing ${prefix}_SERVER_URL or ${prefix}_AUTH_TOKEN in .env.`);
  process.exit(1);
}

const nextLines = setEnvValue(setEnvValue(lines, "MCP_SERVER_URL", nextUrl), "MCP_AUTH_TOKEN", nextToken);
await writeFile(envPath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`);
console.log(`MCP switched to ${mode}: ${nextUrl}`);

function parseEnv(envLines) {
  const result = {};
  for (const line of envLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) continue;
    const key = trimmed.slice(0, equalIndex).trim();
    const value = trimmed.slice(equalIndex + 1).trim();
    result[key] = stripQuotes(value);
  }
  return result;
}

function stripQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function setEnvValue(envLines, key, value) {
  let found = false;
  const nextLines = envLines.map((line) => {
    if (line.trim().startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) nextLines.push(`${key}=${value}`);
  return nextLines;
}
