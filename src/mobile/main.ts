import { createMobileAPI } from "./api";
import { MobileWorkerClient } from "./client";

const client = new MobileWorkerClient(
  new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
);
const { api, dispose } = createMobileAPI(client);
window.pickup = api;
function syncVisibility(): void {
  void client
    .send({
      kind: "setSyncForeground",
      visible: document.visibilityState === "visible",
    })
    .then((result) => {
      if (!result.ok) console.error("mobile-sync-visibility-failed");
    });
}
document.addEventListener("visibilitychange", syncVisibility);
syncVisibility();
window.addEventListener(
  "pagehide",
  () => {
    document.removeEventListener("visibilitychange", syncVisibility);
    dispose();
    client.dispose();
  },
  { once: true },
);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
void import("../renderer/src/main");
