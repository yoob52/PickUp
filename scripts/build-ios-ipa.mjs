import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).version;
const match = /^(0|[1-9]\d*)\.(0|[1-9]\d?)\.(0|[1-9]\d?)$/.exec(version);
if (!match)
  throw new Error(
    `package.json version ${version} must be X.Y.Z with minor/patch 0..99.`,
  );
const [major, minor, patch] = match.slice(1).map(Number);
const build = String(major * 10000 + minor * 100 + patch);

const outDir = join(root, "out", "ios");
const derivedData = join(outDir, "DerivedData");
const payload = join(outDir, "Payload");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(payload, { recursive: true });

execFileSync(
  "xcodebuild",
  [
    "-project",
    "ios/App/App.xcodeproj",
    "-scheme",
    "App",
    "-configuration",
    "Release",
    "-sdk",
    "iphoneos",
    "-destination",
    "generic/platform=iOS",
    "-derivedDataPath",
    derivedData,
    `MARKETING_VERSION=${version}`,
    `CURRENT_PROJECT_VERSION=${build}`,
    "CODE_SIGNING_ALLOWED=NO",
    "CODE_SIGNING_REQUIRED=NO",
    "CODE_SIGN_IDENTITY=",
    "build",
  ],
  { cwd: root, stdio: "inherit" },
);

const app = join(derivedData, "Build/Products/Release-iphoneos/App.app");
execFileSync("ditto", [app, join(payload, "App.app")], { stdio: "inherit" });
const ipa = join(outDir, `PickUp-${version}-unsigned.ipa`);
execFileSync("zip", ["-qry", ipa, "Payload"], {
  cwd: outDir,
  stdio: "inherit",
});
console.log(ipa);
