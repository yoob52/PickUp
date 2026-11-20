import { z } from "zod";
import { serverUrlSchema, type SyncStatus } from "./sync-contracts";

export const DEFAULT_SYNC_SERVER = "https://pickup.3352378.xyz";
const serverUrl = serverUrlSchema.default(DEFAULT_SYNC_SERVER);
const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10).max(1024);
export const accountInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("register"), serverUrl, email, password }),
  z.strictObject({ action: z.literal("login"), serverUrl, email, password }),
  z.strictObject({
    action: z.literal("recover"),
    serverUrl,
    email,
    password,
    recoveryCode: z.string().min(1).max(256),
  }),
  z.strictObject({ action: z.literal("logout") }),
  z.strictObject({ action: z.literal("ackRecovery") }),
  z.strictObject({ action: z.literal("pendingRecovery") }),
  z.strictObject({ action: z.literal("beginHandoff"), serverUrl }),
  z.strictObject({ action: z.literal("pollHandoff") }),
  z.strictObject({ action: z.literal("getHandoffPayload") }),
  z.strictObject({ action: z.literal("cancelHandoff") }),
  z.strictObject({
    action: z.literal("inspectHandoff"),
    payload: z.string().min(1).max(4096),
  }),
  z.strictObject({
    action: z.literal("approveHandoff"),
    payload: z.string().min(1).max(4096),
  }),
]);
export type AccountInput = z.input<typeof accountInputSchema>;
export type AccountReply = {
  status: SyncStatus;
  recoveryCode?: string;
  qrPayload?: string;
  expiresAt?: number;
  pending?: boolean;
  confirmation?: { serverUrl: string; email: string; expiresAt: number };
};
