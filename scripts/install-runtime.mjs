import { spawnSync } from "node:child_process";
// The official downloader uses Node fetch; honor an existing proxy without changing system settings.
const env = { ...process.env };
if (env.HTTPS_PROXY || env.HTTP_PROXY) env.NODE_USE_ENV_PROXY ??= "1";
const result = spawnSync(
  process.execPath,
  ["node_modules/electron/install.js"],
  { stdio: "inherit", env, windowsHide: true },
);
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
