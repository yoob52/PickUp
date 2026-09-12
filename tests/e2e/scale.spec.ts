import { test, expect } from "@playwright/test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { launch, launchEnvironment, tempData, windowByKind } from "./helpers";

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[index];
}

test("1,000 件任务规模与热唤起、保存耗时", async () => {
  test.setTimeout(300_000);
  const directory = await tempData();
  const out = join("docs", "verification");
  await mkdir(out, { recursive: true });
  const application = await launch(launchEnvironment(directory));
  try {
    const page = await windowByKind(application, "main");
    await page.waitForFunction(
      () => typeof window.pickup?.createTask === "function",
    );
    const result = await page.evaluate(async () => {
      const creates: number[] = [];
      const switches: number[] = [];
      const ids: string[] = [];
      const started = performance.now();
      for (let i = 0; i < 1000; i += 1) {
        const t0 = performance.now();
        const created = await window.pickup.createTask({
          commandId: crypto.randomUUID(),
          title: `规模任务 ${i + 1}`,
          note: "",
        });
        creates.push(performance.now() - t0);
        if (!created.ok) return { error: created.message };
        ids.push(created.value.taskId);
      }
      for (let i = 0; i < 10; i += 1) {
        const task = await window.pickup.getTaskDetail({ taskId: ids[i] });
        if (!task.ok) return { error: task.message };
        for (let n = 0; n < 10; n += 1) {
          const saved = await window.pickup.saveBreakpoint({
            commandId: crypto.randomUUID(),
            task: {
              taskId: task.value.task.id,
              expectedVersion: task.value.task.version + n,
            },
            breakpoint: {
              progress: "",
              nextStep: `下一步 ${n + 1}`,
              referenceText: "",
            },
          });
          if (!saved.ok) return { error: saved.message };
        }
      }
      const first = await window.pickup.getTaskDetail({ taskId: ids[0] });
      const second = await window.pickup.getTaskDetail({ taskId: ids[1] });
      if (!first.ok || !second.ok) return { error: "无法读取用于切换的任务" };
      const start = await window.pickup.startTask({
        commandId: crypto.randomUUID(),
        task: {
          taskId: first.value.task.id,
          expectedVersion: first.value.task.version,
        },
      });
      if (!start.ok) return { error: start.message };
      const latestSecond = await window.pickup.getTaskDetail({
        taskId: ids[1],
      });
      const latestFirst = await window.pickup.getTaskDetail({
        taskId: ids[0],
      });
      if (!latestSecond.ok || !latestFirst.ok)
        return { error: "切换前读取失败" };
      for (let i = 0; i < 20; i += 1) {
        const from =
          i % 2 === 0 ? latestFirst.value.task : latestSecond.value.task;
        const to =
          i % 2 === 0 ? latestSecond.value.task : latestFirst.value.task;
        const freshFrom = await window.pickup.getTaskDetail({
          taskId: from.id,
        });
        const freshTo = await window.pickup.getTaskDetail({ taskId: to.id });
        if (!freshFrom.ok || !freshTo.ok) return { error: "切换刷新失败" };
        const t0 = performance.now();
        const switched = await window.pickup.switchTask({
          commandId: crypto.randomUUID(),
          from: {
            taskId: freshFrom.value.task.id,
            expectedVersion: freshFrom.value.task.version,
          },
          to: {
            taskId: freshTo.value.task.id,
            expectedVersion: freshTo.value.task.version,
          },
        });
        switches.push(performance.now() - t0);
        if (!switched.ok) return { error: switched.message };
      }
      const snapshot = await window.pickup.getWorkspaceSnapshot();
      const captureTimes: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const t0 = performance.now();
        const shown = await window.pickup.showCapture();
        captureTimes.push(performance.now() - t0);
        if (!shown.ok) return { error: shown.message };
        await window.pickup.hideCapture();
      }
      return {
        error: null,
        totalMs: performance.now() - started,
        creates,
        switches,
        captureTimes,
        unfinished: snapshot.ok ? snapshot.value.counts.unfinished : -1,
      };
    });
    expect(result.error).toBeNull();
    expect(result.unfinished).toBe(1000);
    const summary = {
      device: "Windows 11 x64",
      samples: {
        create: result.creates.length,
        switch: result.switches.length,
        showCapture: result.captureTimes.length,
      },
      createMs: {
        p50: percentile(result.creates, 50),
        p95: percentile(result.creates, 95),
        max: Math.max(...result.creates),
      },
      switchMs: {
        p50: percentile(result.switches, 50),
        p95: percentile(result.switches, 95),
        max: Math.max(...result.switches),
      },
      showCaptureMs: {
        p50: percentile(result.captureTimes, 50),
        p95: percentile(result.captureTimes, 95),
        max: Math.max(...result.captureTimes),
      },
      totalMs: result.totalMs,
    };
    await writeFile(
      join(out, "scale-results.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    expect(summary.createMs.p95).toBeLessThan(1000);
    expect(summary.switchMs.p95).toBeLessThan(1000);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
