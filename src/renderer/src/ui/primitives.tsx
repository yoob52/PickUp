import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { TaskStatus } from "../../../shared/task";
import { TASK_STATUS_LABEL } from "../../../shared/task";

type ButtonKind = "primary" | "secondary" | "ghost" | "danger";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: ButtonKind;
  icon?: ReactNode;
};

export function Button({
  kind = "primary",
  icon,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={["btn", `btn-${kind}`, className].filter(Boolean).join(" ")}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      className={["icon-button", className].filter(Boolean).join(" ")}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

export function StatusDot({ status }: { status: TaskStatus }) {
  return (
    <span
      className={`status-dot ${status}`}
      title={TASK_STATUS_LABEL[status]}
      aria-hidden="true"
    />
  );
}

export function StatusMark({ status }: { status: TaskStatus }) {
  return (
    <span className="status-mark">
      <StatusDot status={status} />
      {TASK_STATUS_LABEL[status]}
    </span>
  );
}

export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="helper">{hint}</p>
      ) : null}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function NoticeBar({
  tone = "info",
  children,
  action,
}: {
  tone?: "info" | "error" | "ok";
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`notice-bar ${tone}`} role="status">
      <span>{children}</span>
      {action}
    </div>
  );
}
