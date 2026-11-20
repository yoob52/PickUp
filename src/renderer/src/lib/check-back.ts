import { useEffect, useState } from "react";
import type { TaskSummary } from "../../../shared/contracts";
import { dueCheckBacks, nextCheckBackAt } from "../../../shared/task";

/** setTimeout 的最大可用延迟（约 24.8 天）；更远的回看时间到期前会再排一次。 */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

/** 返回已到回看时间的等待事项，并只在下一个回看时间到达时重新计算一次。 */
export function useDueCheckBacks(tasks: readonly TaskSummary[]): TaskSummary[] {
  const [now, setNow] = useState(() => Date.now());
  const next = nextCheckBackAt(tasks, now);

  useEffect(() => {
    if (next === null) return;
    const delay = Math.min(Math.max(next - Date.now(), 0), MAX_TIMER_DELAY);
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [next]);

  return dueCheckBacks(tasks, now);
}
