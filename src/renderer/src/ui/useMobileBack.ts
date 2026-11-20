import { useEffect, useRef } from "react";

type Close = () => void | boolean | Promise<void | boolean | undefined>;
const entries = new Map<string, Close>();
const removed = new Set<string>();
let active: string | undefined;
let queue = Promise.resolve();
let settled: (() => void) | undefined;

function enqueue(action: () => void | Promise<void>) {
  queue = queue.then(action);
}

function back(): Promise<void> {
  return new Promise((resolve) => {
    settled = resolve;
    window.history.back();
  });
}

function push(id: string) {
  active = id;
  window.history.pushState({ ...window.history.state, pickupOverlay: id }, "");
}

function popped(event: PopStateEvent) {
  const previous = active;
  active = event.state?.pickupOverlay;
  if (active && removed.has(active)) {
    window.history.back();
    return;
  }
  const done = settled;
  settled = undefined;
  done?.();
  if (previous && previous !== active) {
    const close = entries.get(previous);
    if (close) {
      void Promise.resolve(close()).then((closed) => {
        if (closed === false && entries.has(previous))
          enqueue(() => push(previous));
      });
    }
  }
}

export function useMobileBack(onClose: Close) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (window.pickup.host !== "mobile") return;
    if (!entries.size) window.addEventListener("popstate", popped);
    const id = crypto.randomUUID();
    let mounted = true;
    entries.set(id, () => close.current());
    enqueue(() => {
      if (mounted) push(id);
    });
    return () => {
      mounted = false;
      entries.delete(id);
      removed.add(id);
      enqueue(async () => {
        if (window.history.state?.pickupOverlay === id) await back();
        if (!entries.size) window.removeEventListener("popstate", popped);
      });
    };
  }, []);
}
