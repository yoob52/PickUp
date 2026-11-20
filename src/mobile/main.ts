import { createMobileAPI } from "./api";
import { MobileWorkerClient } from "./client";

const client = new MobileWorkerClient(
  new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
);
const { api, dispose } = createMobileAPI(client);
window.pickup = api;
window.addEventListener(
  "pagehide",
  () => {
    dispose();
    client.dispose();
  },
  { once: true },
);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
void import("../renderer/src/main");
