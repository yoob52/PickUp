import { z } from "zod";

export const repositoryUrl = "https://github.com/yoob52/PickUp";
export const latestReleaseUrl = `${repositoryUrl}/releases/latest`;
const latestReleaseApi =
  "https://api.github.com/repos/yoob52/PickUp/releases/latest";
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digestPattern = /^sha256:([a-f0-9]{64})$/;

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(
    z.object({
      name: z.string(),
      state: z.string(),
      browser_download_url: z.string(),
      digest: z.string().nullish(),
    }),
  ),
});

export type UpdateOffer = {
  version: string;
  action: "install" | "release";
};

type Installer = { url: string; sha256: string };
export type AvailableRelease = {
  offer: UpdateOffer;
  page: string;
  installer: Installer | null;
};

function isNewer(version: string, currentVersion: string): boolean {
  const current = versionPattern.exec(currentVersion.split("-")[0]);
  const next = versionPattern.exec(version);
  if (!current || !next) throw new Error("invalid-update-version");
  for (let i = 1; i <= 3; i++) {
    const difference = BigInt(next[i]) - BigInt(current[i]);
    if (difference !== 0n) return difference > 0n;
  }
  return currentVersion.includes("-");
}

export async function getAvailableRelease(
  current: string,
  platform: "windows" | "android" | "browser",
): Promise<AvailableRelease | null> {
  const response = await fetch(latestReleaseApi, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("update-check-failed");
  const release = releaseSchema.parse(await response.json());
  const version = release.tag_name.slice(1);
  if (
    release.draft ||
    release.prerelease ||
    !release.tag_name.startsWith("v") ||
    !versionPattern.test(version) ||
    !isNewer(version, current)
  )
    return null;

  const name =
    platform === "windows"
      ? `PickUp.Setup.${version}.exe`
      : platform === "android"
        ? "app-release.apk"
        : null;
  const url = `${repositoryUrl}/releases/download/v${version}/${name}`;
  const asset =
    name &&
    release.assets.find(
      (asset) =>
        asset.name === name &&
        asset.state === "uploaded" &&
        asset.browser_download_url === url,
    );
  const sha256 = asset && asset.digest && digestPattern.exec(asset.digest)?.[1];
  return {
    offer: { version, action: sha256 ? "install" : "release" },
    page: `${repositoryUrl}/releases/tag/v${version}`,
    installer: sha256 ? { url, sha256 } : null,
  };
}
