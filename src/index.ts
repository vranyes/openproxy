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

const server = Bun.serve({ port, fetch: app.fetch });
logger({ level: "info", msg: "listening", port, config: configPath });

// Graceful shutdown: stop accepting, let in-flight streams drain briefly,
// then close the config watcher and exit. Kubernetes sends SIGTERM first and
// SIGKILLs after terminationGracePeriodSeconds regardless.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger({ level: "info", msg: "shutting down", signal });
  try {
    server.stop();
  } catch {
    // already stopped
  }
  store.close();
  setTimeout(() => process.exit(0), 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
