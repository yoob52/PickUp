import { describe, expect, it } from "vitest";
import {
  defaultWidgetBounds,
  floatingWidgetBounds,
  visibleBounds,
} from "../src/main/bounds";

describe("widget 位置校正", () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };

  it.each([
    [0, 0, 0, 0],
    [1856, 0, 1560, 0],
    [0, 976, 0, 792],
    [1856, 976, 1560, 792],
  ])(
    "圆球位于 (%i,%i) 时向可见方向展开且收起回原位",
    (x, y, expandedX, expandedY) => {
      const card = { x: x + 64 - 360, y, width: 360, height: 248 };
      expect(floatingWidgetBounds(card, primary, true)).toEqual({
        x: expandedX,
        y: expandedY,
        width: 360,
        height: 248,
      });
      expect(floatingWidgetBounds(card, primary, false)).toEqual({
        x,
        y,
        width: 64,
        height: 64,
      });
    },
  );

  it("负坐标副屏上展开和收起都保持可见", () => {
    const area = { x: -1280, y: -720, width: 1280, height: 720 };
    const card = { x: -1576, y: -64, width: 360, height: 248 };
    expect(floatingWidgetBounds(card, area, true)).toEqual({
      x: -1280,
      y: -248,
      width: 360,
      height: 248,
    });
    expect(floatingWidgetBounds(card, area, false)).toEqual({
      x: -1280,
      y: -64,
      width: 64,
      height: 64,
    });
  });

  it("可见区域内的位置保持不变", () => {
    const bounds = { x: 100, y: 80, width: 320, height: 248 };
    expect(visibleBounds(bounds, [primary])).toEqual(bounds);
  });

  it("显示器移除后回到主屏可见区域", () => {
    const offscreen = { x: 4000, y: 20, width: 320, height: 248 };
    const next = visibleBounds(offscreen, [primary]);
    expect(next.x).toBe(24);
    expect(next.y).toBe(24);
    expect(next.width).toBe(320);
    expect(next.height).toBe(248);
  });

  it("默认放在主屏右侧且收起时更矮", () => {
    const expanded = defaultWidgetBounds(primary, false);
    const collapsed = defaultWidgetBounds(primary, true);
    expect(expanded.x).toBeGreaterThan(1500);
    expect(collapsed.height).toBeLessThan(expanded.height);
  });
});
