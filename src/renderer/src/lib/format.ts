import type { BreakpointSummary, TaskSummary } from "../../../shared/contracts";

export function formatClock(ms: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ms);
}

export function formatDay(ms: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  }).format(ms);
}

export function formatDateTime(ms: number): string {
  return `${formatDay(ms)} ${formatClock(ms)}`;
}

export function formatStamp(ms: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(ms);
}

export function nextStepText(task: TaskSummary | null | undefined): string {
  const latest = task?.latestBreakpoint;
  if (!latest) return "";
  return latest.nextStep || latest.progress || "";
}

export function breakpointLine(point: BreakpointSummary | null): string {
  if (!point) return "";
  const parts = [point.nextStep, point.progress].filter((part) => part.trim());
  return parts.join(" · ");
}
