import { z } from "zod";
import { isIP } from "node:net";

export type Config = {
  registrationToken?: string;
  accountQuotaBytes?: number;
  trustedProxies?: string[];
  dataDir: string;
  allowedOrigins: string[];
  port: number;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const registrationToken = env.PICKUP_REGISTRATION_TOKEN;
  if (
    registrationToken &&
    (registrationToken.length < 32 || /\s/.test(registrationToken))
  )
    throw new Error(
      "PICKUP_REGISTRATION_TOKEN must contain at least 32 non-whitespace characters when set.",
    );
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .safeParse(env.PORT ?? 8787);
  if (!port.success)
    throw new Error("PORT must be an integer between 1 and 65535.");
  const allowedOrigins = (env.PICKUP_ALLOWED_ORIGINS ?? "https://localhost")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of allowedOrigins) {
    const parsed = URL.canParse(origin) ? new URL(origin) : undefined;
    if (
      !parsed ||
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== origin
    )
      throw new Error(
        "PICKUP_ALLOWED_ORIGINS must be a comma-separated list of exact HTTP(S) origins.",
      );
  }
  return {
    registrationToken,
    accountQuotaBytes: z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(env.PICKUP_ACCOUNT_QUOTA_BYTES ?? 20 * 1024 * 1024),
    trustedProxies: z
      .array(z.string().refine((value) => isIP(value) !== 0))
      .parse(
        (env.PICKUP_TRUSTED_PROXIES ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    port: port.data,
    dataDir: env.PICKUP_DATA_DIR ?? "/data",
    allowedOrigins,
  };
}
