export type Rect = { x: number; y: number; width: number; height: number };

export const WIDGET_ORB_SIZE = 64;

/** card 的右上角保存圆球锚点；展开只选择方向，不移动锚点。 */
export function floatingWidgetBounds(
  card: Rect,
  area: Rect,
  expanded: boolean,
): Rect {
  const size = WIDGET_ORB_SIZE;
  const x = Math.max(
    area.x,
    Math.min(card.x + card.width - size, area.x + area.width - size),
  );
  const y = Math.max(area.y, Math.min(card.y, area.y + area.height - size));
  if (!expanded) return { x, y, width: size, height: size };
  const width = Math.min(card.width, area.width);
  const height = Math.min(card.height, area.height);
  const right = area.x + area.width - x;
  const below = area.y + area.height - y;
  return {
    x: Math.max(
      area.x,
      Math.min(
        right >= width ? x : x + size - width,
        area.x + area.width - width,
      ),
    ),
    y: Math.max(
      area.y,
      Math.min(
        below >= height ? y : y + size - height,
        area.y + area.height - height,
      ),
    ),
    width,
    height,
  };
}

const MIN_VISIBLE = 48;

function overlap(a: Rect, b: Rect): { x: number; y: number } {
  return {
    x: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    y: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/** 保证窗口与至少一个工作区有可操作重叠；否则移到主屏左上可见区域。 */
export function visibleBounds(bounds: Rect, workAreas: Rect[]): Rect {
  const width = Math.max(120, Math.round(bounds.width));
  const height = Math.max(60, Math.round(bounds.height));
  const current = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width,
    height,
  };
  for (const area of workAreas) {
    const hit = overlap(current, area);
    if (hit.x >= MIN_VISIBLE && hit.y >= MIN_VISIBLE) return current;
  }
  const primary = workAreas[0] ?? { x: 0, y: 0, width: 1280, height: 720 };
  return {
    x: primary.x + 24,
    y: primary.y + 24,
    width: Math.min(width, Math.max(120, primary.width - 48)),
    height: Math.min(height, Math.max(60, primary.height - 48)),
  };
}

export function defaultWidgetBounds(workArea: Rect, collapsed: boolean): Rect {
  const width = 320;
  const height = collapsed ? 76 : 248;
  return {
    x: workArea.x + Math.max(24, workArea.width - width - 24),
    y: workArea.y + 24,
    width,
    height,
  };
}
