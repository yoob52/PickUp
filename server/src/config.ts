import { z } from "zod";

export type Config = {
  registrationToken: string;
  dataDir: string;
  allowedOrigins: string[];
  port: number;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const registrationToken = env.PICKUP_REGISTRATION_TOKEN;
  if (
    !registrationToken ||
    registrationToken.length < 32 ||
    /\s/.test(registrationToken)
  )
    throw new Error(
      "PICKUP_REGISTRATION_TOKEN is required and must contain at least 32 non-whitespace characters.",
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
    port: port.data,
    dataDir: env.PICKUP_DATA_DIR ?? "/data",
    allowedOrigins,
  };
}
