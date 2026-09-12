// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  localDayKey,
  localDayRangeUtc,
  msUntilNextLocalDay,
} from "../src/shared/local-date";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/**
 * 时区测试只在本隔离测试进程内设置 TZ，不修改操作系统时区设置。
 * 每个用例结束后恢复原值，避免影响同进程的其他用例。
 */
const originalTimeZone = process.env.TZ;

afterEach(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

function iso(utcMs: number): string {
  return new Date(utcMs).toISOString();
}

function rangeAt(utcMs: number) {
  return localDayRangeUtc(utcMs);
}

/** 断言区间覆盖 utcMs，且区间内每个采样点的本地日都等于 dayKey（左闭右开、不含终点）。 */
function expectRangeCoveringDay(
  utcMs: number,
  expectedDayKey: string,
  stepMs = 30 * MINUTE,
): void {
  const range = rangeAt(utcMs);
  expect(range.dayKey).toBe(expectedDayKey);
  expect(utcMs).toBeGreaterThanOrEqual(range.startUtc);
  expect(utcMs).toBeLessThan(range.endUtc);
  expect(localDayKey(range.startUtc)).toBe(range.dayKey);
  expect(localDayKey(range.endUtc)).not.toBe(range.dayKey);
  for (let sample = range.startUtc; sample < range.endUtc; sample += stepMs)
    expect(localDayKey(sample)).toBe(range.dayKey);
}

describe("本地日期区间", () => {
  it("东八区把跨 UTC 日的时间切到同一本地日", () => {
    process.env.TZ = "Asia/Shanghai";
    const instant = Date.parse("2026-09-09T23:30:00.000Z");
    const range = rangeAt(instant);
    expect(range.dayKey).toBe("2026-09-10");
    expect(iso(range.startUtc)).toBe("2026-09-09T16:00:00.000Z");
    expect(iso(range.endUtc)).toBe("2026-09-10T16:00:00.000Z");
    expect(range.endUtc - range.startUtc).toBe(24 * HOUR);
    expectRangeCoveringDay(instant, "2026-09-10");
  });

  it("西半球时区的本地日可能早于 UTC 日", () => {
    process.env.TZ = "America/New_York";
    const instant = Date.parse("2026-09-10T02:00:00.000Z");
    const range = rangeAt(instant);
    expect(range.dayKey).toBe("2026-09-09");
    expect(iso(range.startUtc)).toBe("2026-09-09T04:00:00.000Z");
    expect(iso(range.endUtc)).toBe("2026-09-10T04:00:00.000Z");
    expectRangeCoveringDay(instant, "2026-09-09");
  });

  it("夏令时开始当天是 23 小时（America/New_York）", () => {
    process.env.TZ = "America/New_York";
    const range = rangeAt(Date.parse("2026-03-08T12:00:00.000Z"));
    expect(range.dayKey).toBe("2026-03-08");
    expect(iso(range.startUtc)).toBe("2026-03-08T05:00:00.000Z");
    expect(iso(range.endUtc)).toBe("2026-03-09T04:00:00.000Z");
    expect(range.endUtc - range.startUtc).toBe(23 * HOUR);
    expectRangeCoveringDay(
      Date.parse("2026-03-08T12:00:00.000Z"),
      "2026-03-08",
    );
  });

  it("夏令时结束当天是 25 小时，回拨后的重复小时仍属于同一天", () => {
    process.env.TZ = "America/New_York";
    const range = rangeAt(Date.parse("2026-11-01T12:00:00.000Z"));
    expect(range.dayKey).toBe("2026-11-01");
    expect(iso(range.startUtc)).toBe("2026-11-01T04:00:00.000Z");
    expect(iso(range.endUtc)).toBe("2026-11-02T05:00:00.000Z");
    expect(range.endUtc - range.startUtc).toBe(25 * HOUR);
    expectRangeCoveringDay(
      Date.parse("2026-11-01T12:00:00.000Z"),
      "2026-11-01",
    );
    // 本地 01:30 出现两次：平台取较早实例（EDT），仍落在当天区间内
    expect(localDayKey(Date.parse("2026-11-01T05:30:00.000Z"))).toBe(
      "2026-11-01",
    );
  });

  it("午夜不存在时当天从跳变后的第一个时刻开始（America/Santiago 2026-09-06）", () => {
    process.env.TZ = "America/Santiago";
    const instant = Date.parse("2026-09-06T12:00:00.000Z");
    const range = rangeAt(instant);
    expect(range.dayKey).toBe("2026-09-06");
    // 本地 2026-09-06 00:00 不存在（00:00 直接跳到 01:00）：当天起点是 04:00Z，
    // 不是偏移迭代振荡得到的 2026-09-06T03:00:00Z（本地 09-05 23:00）
    expect(iso(range.startUtc)).toBe("2026-09-06T04:00:00.000Z");
    expect(iso(range.endUtc)).toBe("2026-09-07T03:00:00.000Z");
    expect(range.endUtc - range.startUtc).toBe(23 * HOUR);
    expectRangeCoveringDay(instant, "2026-09-06");

    // 前一天本地 23:30 的完成记录属于前一天，不进入当天区间
    const beforeMidnight = Date.parse("2026-09-06T03:30:00.000Z");
    expect(localDayKey(beforeMidnight)).toBe("2026-09-05");
    expect(beforeMidnight).toBeLessThan(range.startUtc);
    expectRangeCoveringDay(beforeMidnight, "2026-09-05");
  });

  it("午夜回拨使前一天变成 25 小时（America/Santiago 2026-04-05）", () => {
    process.env.TZ = "America/Santiago";
    const range = rangeAt(Date.parse("2026-04-05T12:00:00.000Z"));
    expect(range.dayKey).toBe("2026-04-05");
    expect(iso(range.startUtc)).toBe("2026-04-05T04:00:00.000Z");
    expect(iso(range.endUtc)).toBe("2026-04-06T04:00:00.000Z");
    expect(range.endUtc - range.startUtc).toBe(24 * HOUR);

    const previous = rangeAt(range.startUtc - 1);
    expect(previous.dayKey).toBe("2026-04-04");
    expect(iso(previous.startUtc)).toBe("2026-04-04T03:00:00.000Z");
    expect(previous.endUtc - previous.startUtc).toBe(25 * HOUR);

    // 回拨后本地 2026-04-04 23:30 的记录属于 04-04，不属于 04-05
    const rewound = Date.parse("2026-04-05T03:30:00.000Z");
    expect(localDayKey(rewound)).toBe("2026-04-04");
    expect(rewound).toBeLessThan(range.startUtc);
    expectRangeCoveringDay(rewound, "2026-04-04");
  });

  it("本地零点出现两次时取较早实例（America/Havana 2026-11-01）", () => {
    process.env.TZ = "America/Havana";
    const range = rangeAt(Date.parse("2026-11-01T12:00:00.000Z"));
    expect(range.dayKey).toBe("2026-11-01");
    // 本地 00:00 同时对应 04:00Z 与 05:00Z：取较早者，当天因此是 25 小时
    expect(iso(range.startUtc)).toBe("2026-11-01T04:00:00.000Z");
    expect(iso(range.endUtc)).toBe("2026-11-02T05:00:00.000Z");
    expect(range.endUtc - range.startUtc).toBe(25 * HOUR);
    expectRangeCoveringDay(
      Date.parse("2026-11-01T12:00:00.000Z"),
      "2026-11-01",
    );

    const previous = rangeAt(range.startUtc - 1);
    expect(previous.dayKey).toBe("2026-10-31");
    expect(previous.endUtc).toBe(range.startUtc);
  });

  it("跨月与跨年边界按本地日解释", () => {
    process.env.TZ = "Asia/Shanghai";
    const yearEnd = rangeAt(Date.parse("2026-12-31T20:00:00.000Z"));
    expect(yearEnd.dayKey).toBe("2027-01-01");
    expect(iso(yearEnd.startUtc)).toBe("2026-12-31T16:00:00.000Z");
    expectRangeCoveringDay(
      Date.parse("2026-12-31T20:00:00.000Z"),
      "2027-01-01",
    );

    const monthEnd = rangeAt(Date.parse("2026-01-31T19:30:00.000Z"));
    expect(monthEnd.dayKey).toBe("2026-02-01");
    expectRangeCoveringDay(
      Date.parse("2026-01-31T19:30:00.000Z"),
      "2026-02-01",
    );
  });

  it("左闭右开：区间起点属于当天，终点属于次日", () => {
    process.env.TZ = "Asia/Shanghai";
    const range = rangeAt(Date.parse("2026-06-15T04:00:00.000Z"));
    expect(localDayKey(range.startUtc)).toBe(range.dayKey);
    expect(localDayKey(range.endUtc)).not.toBe(range.dayKey);

    process.env.TZ = "America/Santiago";
    const dstDay = rangeAt(Date.parse("2026-09-06T12:00:00.000Z"));
    expect(localDayKey(dstDay.startUtc)).toBe(dstDay.dayKey);
    expect(localDayKey(dstDay.endUtc)).not.toBe(dstDay.dayKey);
  });

  it("相邻区间首尾相接，不重叠也不留空隙", () => {
    for (const [timeZone, dayMoment] of [
      ["Asia/Shanghai", "2026-05-05T10:00:00.000Z"],
      ["America/Santiago", "2026-09-06T12:00:00.000Z"],
      ["America/Santiago", "2026-04-04T12:00:00.000Z"],
      ["America/Havana", "2026-11-01T12:00:00.000Z"],
    ] as const) {
      process.env.TZ = timeZone;
      const today = rangeAt(Date.parse(dayMoment));
      const justBefore = rangeAt(today.startUtc - 1);
      const atEnd = rangeAt(today.endUtc);
      expect(justBefore.endUtc).toBe(today.startUtc);
      expect(atEnd.startUtc).toBe(today.endUtc);
      expect(atEnd.dayKey).not.toBe(today.dayKey);
    }
  });

  it("默认使用设备时区，区间覆盖当前时刻且长度在 23—25 小时之间", () => {
    const now = Date.now();
    const range = localDayRangeUtc(now);
    expect(now).toBeGreaterThanOrEqual(range.startUtc);
    expect(now).toBeLessThan(range.endUtc);
    expect(localDayKey(now)).toBe(range.dayKey);
    expect(localDayKey(range.startUtc)).toBe(range.dayKey);
    expect(localDayKey(range.endUtc)).not.toBe(range.dayKey);
    const hours = (range.endUtc - range.startUtc) / HOUR;
    expect(hours).toBeGreaterThanOrEqual(23);
    expect(hours).toBeLessThanOrEqual(25);
    expect(hours).toBe(Math.round(hours));
  });

  it("距下一本地日的等待时间落在当天剩余区间内", () => {
    const now = Date.now();
    const range = localDayRangeUtc(now);
    expect(msUntilNextLocalDay(now)).toBe(range.endUtc - now);
    expect(msUntilNextLocalDay(range.endUtc - 1)).toBe(1);
  });
});
