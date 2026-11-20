import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelay } from "../server/src/relay";

export async function startSyncRelay() {
  const directory = await mkdtemp(join(tmpdir(), "pickup-client-relay-"));
  const token = crypto.randomUUID() + crypto.randomUUID();
  const relay = createRelay(
    {
      registrationToken: token,
      dataDir: directory,
      allowedOrigins: [],
      port: 8787,
    },
    () => {},
  );
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const url = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
  return {
    url,
    token,
    directory,
    relay,
    close: async () => {
      await relay.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
