import { z } from "zod";
export const createTaskSchema = z
  .object({
    commandId: z.uuid(),
    title: z.string().trim().min(1, "请填写任务标题"),
    note: z.string(),
  })
  .strict();
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type Task = {
  id: string;
  title: string;
  note: string;
  status: "todo" | "doing" | "paused" | "waiting" | "done" | "cancelled";
  createdAt: number;
  version: number;
};
export type Snapshot = { revision: number; tasks: Task[] };
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "COMMAND_ID_REUSED"
  | "STORAGE_ERROR"
  | "DB_UNAVAILABLE"
  | "OUTCOME_UNKNOWN";
export type Result<T> =
  | { ok: true; value: T; revision: number }
  | { ok: false; code: ErrorCode; message: string };
export type Request =
  | { kind: "snapshot" }
  | { kind: "create"; input: CreateTaskInput }
  | { kind: "close" };
export type PickupAPI = {
  snapshot(): Promise<Result<Snapshot>>;
  createTask(input: CreateTaskInput): Promise<Result<{ taskId: string }>>;
  onStateChanged(listener: (revision: number) => void): () => void;
};
