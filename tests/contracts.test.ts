import { describe, expect, it } from "vitest";
import { createTaskSchema } from "../src/shared/contracts";
describe("capture input boundary", () => {
  it("rejects blank and unexpected payloads", () => {
    const base = {
      commandId: "00000000-0000-4000-8000-000000000001",
      title: "   ",
      note: "",
    };
    expect(createTaskSchema.safeParse(base).success).toBe(false);
    expect(
      createTaskSchema.safeParse({ ...base, title: "task", status: "doing" })
        .success,
    ).toBe(false);
  });
  it("normalizes title while preserving note text", () => {
    expect(
      createTaskSchema.parse({
        commandId: "00000000-0000-4000-8000-000000000001",
        title: "  中文事项  ",
        note: "line1\nline2",
      }).title,
    ).toBe("中文事项");
  });
});
