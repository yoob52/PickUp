import { spawn } from "node:child_process";
import electron from "electron";
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [".", "--integration-test"], {
  stdio: "inherit",
  env,
  windowsHide: true,
});
const timeout = setTimeout(() => {
  child.kill();
  console.error("Integration test timeout");
  process.exitCode = 1;
}, 30000);
child.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  clearTimeout(timeout);
  process.exitCode = code ?? 1;
});
