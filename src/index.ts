import { createApp } from "./server";
import { createConfigStore } from "./ops/config";
import { jsonLogger } from "./ops/log";

const configPath = process.argv[2] ?? "examples/gateway.yaml";
const port = Number(process.env.PORT ?? 8080);
const logger = jsonLogger();

const store = createConfigStore(configPath, { logger });
// Getter semantics: store.current is a live value; the arrow re-reads it per request.
// Do NOT pass the bare value (snapshot).
const app = createApp(() => store.current, { logger });

Bun.serve({ port, fetch: app.fetch });
logger({ level: "info", msg: "listening", port, config: configPath });
