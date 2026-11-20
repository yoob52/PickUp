import { z } from "zod";

export const serverUrlSchema = z
  .string()
  .url()
  .transform((value, ctx) => {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "同步地址必须使用 HTTPS；仅 localhost 可使用 HTTP，且不能包含凭据、查询或片段。",
      });
      return z.NEVER;
    }
    return url.href.replace(/\/+$/, "");
  });

export const enableSyncSchema = z.strictObject({
  serverUrl: serverUrlSchema,
  registrationToken: z.string().min(32).max(4096).regex(/^\S+$/),
});
export type EnableSyncInput = z.infer<typeof enableSyncSchema>;
export type SyncStatus = {
  enabled: boolean;
  serverUrl: string | null;
  running: boolean;
  stopped: boolean;
  lastSuccess: number | null;
  error: string | null;
  retryAt: number | null;
};
