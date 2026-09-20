import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { DialogRequest } from "../../../src/shared/protocol";
import { Icon } from "./Icons";

export interface DialogHostProps {
  readonly dialog: DialogRequest | null;
  readonly onRespond: (id: string, response: Record<string, unknown>) => void;
}

export function DialogHost({ dialog, onRespond }: DialogHostProps): JSX.Element | null {
  const [value, setValue] = useState("");

  useEffect(() => {
    setValue(dialog?.defaultValue ?? "");
  }, [dialog?.id, dialog?.defaultValue]);

  if (dialog === null) return null;

  const cancel = (): void => onRespond(dialog.id, { cancelled: true });

  return (
    <div className="dialog-mask" onClick={cancel}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <Icon name="sparkle" size={14} />
          <span>{dialog.title ?? dialogLabel(dialog.method)}</span>
        </div>
        {dialog.message !== undefined && <p className="dialog-message">{dialog.message}</p>}

        {dialog.method === "select" && (
          <div className="dialog-options">
            {(dialog.options ?? []).map((option) => (
              <button
                key={option.id}
                type="button"
                className="dialog-option"
                onClick={() => onRespond(dialog.id, { value: option.id })}
              >
                <span className="dialog-option-label">{option.label}</span>
                {option.description !== undefined && (
                  <span className="dialog-option-desc">{option.description}</span>
                )}
              </button>
            ))}
            {(dialog.options ?? []).length === 0 && <div className="popover-empty">No options.</div>}
          </div>
        )}

        {dialog.method === "confirm" && (
          <div className="dialog-actions">
            <button type="button" className="btn ghost" onClick={() => onRespond(dialog.id, { confirmed: false })}>
              No
            </button>
            <button type="button" className="btn primary" onClick={() => onRespond(dialog.id, { confirmed: true })}>
              Yes
            </button>
          </div>
        )}

        {dialog.method === "input" && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onRespond(dialog.id, { value });
            }}
          >
            <input
              autoFocus
              className="dialog-input"
              placeholder={dialog.placeholder ?? ""}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <div className="dialog-actions">
              <button type="button" className="btn ghost" onClick={cancel}>
                Cancel
              </button>
              <button type="submit" className="btn primary">
                Submit
              </button>
            </div>
          </form>
        )}

        {dialog.method === "editor" && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onRespond(dialog.id, { value });
            }}
          >
            <textarea
              autoFocus
              className="dialog-editor"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <div className="dialog-actions">
              <button type="button" className="btn ghost" onClick={cancel}>
                Cancel
              </button>
              <button type="submit" className="btn primary">
                Submit
              </button>
            </div>
          </form>
        )}

        {dialog.method === "select" && (
          <div className="dialog-actions">
            <button type="button" className="btn ghost" onClick={cancel}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function dialogLabel(method: DialogRequest["method"]): string {
  switch (method) {
    case "select":
      return "Choose an option";
    case "confirm":
      return "Confirm";
    case "input":
      return "Input";
    case "editor":
      return "Edit";
    default:
      return "pi";
  }
}
