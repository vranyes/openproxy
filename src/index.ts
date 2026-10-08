import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { GatewayConfigSchema } from "./config";
import { createApp } from "./server";

const configPath = process.argv[2] ?? "examples/gateway.yaml";
const raw = parse(readFileSync(configPath, "utf8"));
const config = GatewayConfigSchema.parse(raw);

const port = Number(process.env.PORT ?? 8080);
const app = createApp(config);

Bun.serve({ port, fetch: app.fetch });
console.log(`openproxy listening on :${port} (config: ${configPath})`);
