import { readConfig } from "./config.js";
import { createRelay } from "./relay.js";

try {
  const config = readConfig();
  const relay = createRelay(config);
  relay.server.on("error", () => {
    console.error(
      "Sync server could not listen; check PORT and data directory permissions.",
    );
    void relay.close().finally(() => {
      process.exitCode = 1;
    });
  });
  relay.server.listen(config.port, "0.0.0.0");
  const shutdown = () => {
    void relay.close().catch(() => {
      console.error("Sync server shutdown failed.");
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch {
  console.error(
    "Sync server startup failed. Set PICKUP_REGISTRATION_TOKEN (at least 32 non-whitespace characters), validate PORT/origins, and check PICKUP_DATA_DIR permissions.",
  );
  process.exitCode = 1;
}
