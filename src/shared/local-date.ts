/**
 * 本地日期边界计算。展示端按设备当前时区解释 UTC 时间：
 * 先把 UTC 毫秒映射为设备本地日历日，再求该本地日的 [startUtc, endUtc) 左闭右开区间。
 * 不按固定 24 小时相加，也不截取 ISO 字符串前缀。
 *
 * 本地日历日与本地零点都交给平台原生的本地时区能力（`Date` 的本地解释）：
 * 自行按偏移迭代推断会在夏令时跳变时振荡并返回错误候选（例如 America/Santiago 的
 * 不存在午夜）。平台按既定规则消歧：
 * - 该本地墙钟时间不存在（时钟前跳）时，解释为跳变后的第一个时刻；
 * - 该本地墙钟时间出现两次（时钟回拨）时，取较早的实例。
 * 因此切换当天的区间长度可能是 23 或 25 小时，区间仍覆盖该本地日的全部时刻。
 */

export type LocalDayRange = {
  dayKey: string;
  startUtc: number;
  endUtc: number;
};

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** UTC 毫秒 → 设备本地日历日（年、0 基月份、日）。 */
function localCalendarDate(utcMs: number): {
  year: number;
  month: number;
  day: number;
} {
  const local = new Date(utcMs);
  return {
    year: local.getFullYear(),
    month: local.getMonth(),
    day: local.getDate(),
  };
}

/**
 * 求本地 y-m-d 00:00 对应的 UTC 毫秒。
 * 使用平台原生本地时间构造函数解释墙钟时间，不自行迭代推断时区偏移；
 * 夏令时切换使该午夜不存在或重复时，按文件头的消歧规则返回确定值。
 */
function instantForLocalMidnight(
  year: number,
  month: number,
  day: number,
): number {
  return new Date(year, month, day, 0, 0, 0, 0).getTime();
}

export function localDayKey(utcMs: number): string {
  const { year, month, day } = localCalendarDate(utcMs);
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

/** 返回 utcMs 所在本地日的 [startUtc, endUtc) 区间及 dayKey。 */
export function localDayRangeUtc(utcMs: number): LocalDayRange {
  const { year, month, day } = localCalendarDate(utcMs);
  const startUtc = instantForLocalMidnight(year, month, day);
  const nextDay = new Date(Date.UTC(year, month, day + 1));
  const endUtc = instantForLocalMidnight(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth(),
    nextDay.getUTCDate(),
  );
  return { dayKey: localDayKey(utcMs), startUtc, endUtc };
}

/** 距下一个本地日开始的毫秒数；已越过终点时返回 1，便于立即刷新。 */
export function msUntilNextLocalDay(utcMs: number): number {
  const { endUtc } = localDayRangeUtc(utcMs);
  return Math.max(1, endUtc - utcMs);
}
