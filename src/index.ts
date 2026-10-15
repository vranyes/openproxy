import { createApp } from "./server";
import { createModelsDevStore } from "./modelsdev";
import { authStartupWarning } from "./ops/auth";
import { createConfigStore } from "./ops/config";
import { jsonLogger } from "./ops/log";

const configPath = process.argv[2] ?? "examples/gateway.yaml";
const port = Number(process.env.PORT ?? 8080);
const logger = jsonLogger();

const store = createConfigStore(configPath, { logger });
// models.dev store loads its on-disk snapshot synchronously (fail-open) and
// refreshes the catalog in the background.
const modelsDev = createModelsDevStore({ logger });
// Getter semantics: store.current is a live value; the arrow re-reads it per request.
// Do NOT pass the bare value (snapshot).
const app = createApp(() => store.current, { logger, modelsdev: () => modelsDev.index });
void modelsDev.refresh(); // non-blocking startup fetch

// F7a: one startup line describing the auth posture (warn when open, error when
// misconfigured). Never emitted from createApp.
const authWarning = authStartupWarning(store.current.auth);
if (authWarning) logger(authWarning);

Bun.serve({ port, fetch: app.fetch });
logger({ level: "info", msg: "listening", port, config: configPath });
