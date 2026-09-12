import { describe, expect, it } from "vitest";
import { defaultWidgetBounds, visibleBounds } from "../src/main/bounds";

describe("widget 位置校正", () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };

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
