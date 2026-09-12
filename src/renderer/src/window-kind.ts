export type WindowKind = "main" | "capture" | "widget";

/** 仅用于选择根组件。查询参数不是权限证明，窗口身份由 main 创建时决定。 */
export function getWindowKind(): WindowKind {
  const value = new URLSearchParams(window.location.search).get("window");
  if (value === "capture" || value === "widget") return value;
  return "main";
}
