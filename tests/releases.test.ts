import { afterEach, expect, it, vi } from "vitest";
import { getAvailableRelease, repositoryUrl } from "../src/shared/releases";

const tag = "v1.10.0";
const sha256 = "a".repeat(64);
const exe = `PickUp.Setup.${tag.slice(1)}.exe`;
const apk = "app-release.apk";
const asset = (name: string) => ({
  name,
  state: "uploaded",
  digest: `sha256:${sha256}`,
  browser_download_url: `${repositoryUrl}/releases/download/${tag}/${name}`,
});

function release(overrides: Record<string, unknown> = {}) {
  const fetch = vi.fn(async () =>
    Response.json({
      tag_name: tag,
      draft: false,
      prerelease: false,
      assets: [asset(exe), asset(apk)],
      ...overrides,
    }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

it("compares numeric versions and picks the verified installer for this platform", async () => {
  const fetch = release();
  await expect(getAvailableRelease("1.9.99", "windows")).resolves.toMatchObject(
    {
      offer: { version: "1.10.0", action: "install" },
      installer: { url: asset(exe).browser_download_url, sha256 },
    },
  );
  await expect(getAvailableRelease("1.9.99", "android")).resolves.toMatchObject(
    {
      offer: { action: "install" },
      installer: { url: asset(apk).browser_download_url, sha256 },
    },
  );
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/yoob52/PickUp/releases/latest",
    expect.any(Object),
  );
});

it("does not offer current, older, or prerelease builds", async () => {
  release();
  await expect(getAvailableRelease("1.10.0", "windows")).resolves.toBeNull();
  await expect(getAvailableRelease("2.0.0", "android")).resolves.toBeNull();
  release({ prerelease: true });
  await expect(getAvailableRelease("1.9.99", "android")).resolves.toBeNull();
});

it("links to the release when the platform cannot install or the asset is not yet trustworthy", async () => {
  release();
  await expect(getAvailableRelease("1.9.99", "browser")).resolves.toEqual({
    offer: { version: "1.10.0", action: "release" },
    installer: null,
    page: `${repositoryUrl}/releases/tag/${tag}`,
  });
  release({
    assets: [
      {
        ...asset(apk),
        browser_download_url: "https://example.com/app-release.apk",
      },
    ],
  });
  await expect(getAvailableRelease("1.9.99", "android")).resolves.toMatchObject(
    {
      offer: { action: "release" },
      installer: null,
    },
  );
  release({ assets: [{ ...asset(exe), digest: null }] });
  await expect(getAvailableRelease("1.9.99", "windows")).resolves.toMatchObject(
    {
      offer: { action: "release" },
      installer: null,
    },
  );
});

it("does not report being up to date when GitHub rejects the request", async () => {
  release().mockResolvedValue(new Response(null, { status: 403 }));
  await expect(getAvailableRelease("1.9.99", "windows")).rejects.toThrow(
    "update-check-failed",
  );
});
