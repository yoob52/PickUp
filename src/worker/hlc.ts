import { z } from "zod";

export type Hlc = { wallMs: number; counter: number; deviceId: string };
const MAX_COUNTER = 9_999_999_999;
const deviceIdSchema = z.uuid();
export const hlcSchema = z
  .string()
  .regex(
    /^\d{16}:\d{10}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  )
  .refine(
    (value) =>
      Number.isSafeInteger(Number(value.slice(0, 16))) &&
      deviceIdSchema.safeParse(value.slice(28)).success,
  );

export function encodeHlc(value: Hlc): string {
  if (
    !Number.isSafeInteger(value.wallMs) ||
    value.wallMs < 0 ||
    !Number.isInteger(value.counter) ||
    value.counter < 0 ||
    value.counter > MAX_COUNTER ||
    !deviceIdSchema.safeParse(value.deviceId).success
  )
    throw new RangeError("Invalid hybrid logical clock");
  return `${String(value.wallMs).padStart(16, "0")}:${String(value.counter).padStart(10, "0")}:${value.deviceId.toLowerCase()}`;
}

export function decodeHlc(value: string): Hlc {
  hlcSchema.parse(value);
  const [wallMs, counter, deviceId] = value.split(":");
  return { wallMs: Number(wallMs), counter: Number(counter), deviceId };
}

function advance(wallMs: number, counter: number, deviceId: string): string {
  return encodeHlc(
    counter > MAX_COUNTER
      ? { wallMs: wallMs + 1, counter: 0, deviceId }
      : { wallMs, counter, deviceId },
  );
}

export function tick(
  last: string | null,
  deviceId: string,
  now = Date.now(),
): string {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new RangeError("Invalid clock time");
  const prior = last === null ? null : decodeHlc(last);
  const wallMs = Math.max(now, prior?.wallMs ?? 0);
  return advance(
    wallMs,
    prior?.wallMs === wallMs ? prior.counter + 1 : 0,
    deviceId,
  );
}

export function receive(
  last: string | null,
  remote: string,
  deviceId: string,
  now = Date.now(),
): string {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new RangeError("Invalid clock time");
  const prior = last === null ? null : decodeHlc(last);
  const other = decodeHlc(remote);
  const wallMs = Math.max(now, prior?.wallMs ?? 0, other.wallMs);
  const counter =
    prior?.wallMs === wallMs && other.wallMs === wallMs
      ? Math.max(prior.counter, other.counter) + 1
      : prior?.wallMs === wallMs
        ? prior.counter + 1
        : other.wallMs === wallMs
          ? other.counter + 1
          : 0;
  return advance(wallMs, counter, deviceId);
}
