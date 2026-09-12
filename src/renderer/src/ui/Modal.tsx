import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { IconButton } from "./primitives";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  eyebrow,
  wide,
  stacked,
  onClose,
  children,
  labelledBy,
}: {
  title: string;
  eyebrow?: string;
  wide?: boolean;
  stacked?: boolean;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
}) {
  const dialog = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);
  if (opener.current === null && typeof document !== "undefined") {
    opener.current = document.activeElement;
  }
  const headingId = useId();
  const labelId = labelledBy ?? headingId;

  useEffect(() => {
    const node = dialog.current;
    const focusables = () =>
      node ? [...node.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
    const preferred =
      node?.querySelector<HTMLElement>(
        "input:not([disabled]), textarea:not([disabled])",
      ) ?? focusables().find((item) => !item.hasAttribute("data-close"));
    (preferred ?? focusables()[0])?.focus();
    return () => {
      const previous = opener.current;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialog.current) return;
    const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className={
        stacked ? "modal-backdrop open stacked" : "modal-backdrop open"
      }
      onKeyDown={onKeyDown}
    >
      <div
        className="modal-scrim"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      />
      <section
        ref={dialog}
        className={wide ? "modal detail-modal" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <div>
            {eyebrow ? <div className="modal-eyebrow">{eyebrow}</div> : null}
            <h2 id={headingId}>{title}</h2>
          </div>
          <IconButton label="关闭" data-close="true" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        {children}
      </section>
    </div>
  );
}
