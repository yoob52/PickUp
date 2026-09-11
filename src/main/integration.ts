import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreClient } from "./worker-client";
import type { Snapshot } from "../shared/contracts";
export async function runIntegration() {
  const directory = await mkdtemp(join(tmpdir(), "pickup-integration-"));
  const file = join(directory, "test.sqlite");
  let client: StoreClient | undefined;
  try {
    client = new StoreClient(file);
    await client.ready;
    const initial = await client.send<Snapshot>({ kind: "snapshot" });
    assert(initial.ok);
    assert.equal(initial.value.tasks.length, 0);
    const input = {
      commandId: randomUUID(),
      title: "恢复本地状态",
      note: "中文断点与备注",
    };
    const first = await client.send<{ taskId: string }>({
      kind: "create",
      input,
    });
    assert(first.ok);
    const repeats = await Promise.all(
      Array.from({ length: 10 }, () => client!.send({ kind: "create", input })),
    );
    assert(
      repeats.every(
        (result) => result.ok && result.revision === first.revision,
      ),
    );
    const bad = await client.send({
      kind: "create",
      input: { ...input, title: "different" },
    });
    assert(!bad.ok);
    assert.equal(bad.code, "COMMAND_ID_REUSED");
    const another = await client.send({
      kind: "create",
      input: { ...input, commandId: randomUUID() },
    });
    assert(another.ok);
    await client.close();
    client = new StoreClient(file);
    await client.ready;
    const recovered = await client.send<Snapshot>({ kind: "snapshot" });
    assert(recovered.ok);
    assert.equal(recovered.value.tasks.length, 2);
    assert.equal(recovered.value.revision, 2);
    assert(
      recovered.value.tasks.every(
        (task) => task.status === "todo" && task.note === input.note,
      ),
    );
    const retried = await client.send({ kind: "create", input });
    assert(retried.ok);
    assert.equal(retried.revision, first.revision);
    console.log(
      JSON.stringify({
        integration: "passed",
        checks: [
          "real Electron worker + SQLite",
          "idempotent replay",
          "different payload rejection",
          "independent same-title tasks",
          "restart persistence",
        ],
        sqliteVersion: client.sqliteVersion,
        runtime: process.versions,
      }),
    );
  } finally {
    if (client) await client.close();
    await rm(directory, { recursive: true, force: true });
  }
}
