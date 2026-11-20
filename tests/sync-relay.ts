import { once } from "node:events";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { createRelay } from "../server/src/relay";

export async function startSyncRelay() {
  const directory = await mkdtemp(join(tmpdir(), "pickup-client-relay-"));
  const token = crypto.randomUUID() + crypto.randomUUID();
  const create = () =>
    createRelay(
      {
        registrationToken: token,
        dataDir: directory,
        allowedOrigins: [],
        port: 8787,
      },
      () => {},
    );
  let relay = create();
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const url = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
  return {
    url,
    token,
    directory,
    relay,
    backup: async () => {
      const source = new DatabaseSync(join(directory, "sync.sqlite"));
      const path = join(directory, "earlier.sqlite");
      try {
        await backup(source, path);
      } finally {
        source.close();
      }
      return path;
    },
    restore: async (path: string) => {
      const port = (relay.server.address() as AddressInfo).port;
      await relay.close();
      await copyFile(path, join(directory, "sync.sqlite"));
      relay = create();
      relay.server.listen(port, "127.0.0.1");
      await once(relay.server, "listening");
    },
    close: async () => {
      await relay.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
