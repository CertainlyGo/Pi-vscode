import type { JSX } from "react";
import type { Toast } from "../store";
import { Icon } from "./Icons";
import type { IconName } from "./Icons";

export interface ToastsProps {
  readonly toasts: readonly Toast[];
  readonly onDismiss: (id: string) => void;
}

export function Toasts({ toasts, onDismiss }: ToastsProps): JSX.Element | null {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <button key={toast.id} type="button" className={`toast ${toast.level}`} onClick={() => onDismiss(toast.id)}>
          <Icon name={iconFor(toast.level)} size={14} />
          <span>{toast.message}</span>
        </button>
      ))}
    </div>
  );
}

function iconFor(level: Toast["level"]): IconName {
  if (level === "error") return "error";
  if (level === "warn") return "warning";
  if (level === "success") return "check";
  return "info";
}
