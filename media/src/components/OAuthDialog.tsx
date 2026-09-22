import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { OAuthPromptView } from "../../../src/shared/protocol";
import { Icon } from "./Icons";

export interface OAuthDialogProps {
  readonly prompt: OAuthPromptView | null;
  readonly onRespond: (value: string | null) => void;
}

export function OAuthDialog({ prompt, onRespond }: OAuthDialogProps): JSX.Element | null {
  const [value, setValue] = useState("");

  useEffect(() => {
    setValue("");
  }, [prompt?.message]);

  if (prompt === null) return null;

  return (
    <div className="dialog-mask" onClick={() => onRespond(null)}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <Icon name="key" size={14} />
          <span>Sign in</span>
        </div>
        <p className="dialog-message">{prompt.message}</p>

        {prompt.type === "select" ? (
          <div className="dialog-options">
            {(prompt.options ?? []).map((option) => (
              <button
                key={option.id}
                type="button"
                className="dialog-option"
                onClick={() => onRespond(option.id)}
              >
                <span className="dialog-option-label">{option.label}</span>
                {option.description !== undefined && (
                  <span className="dialog-option-desc">{option.description}</span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (value.trim().length > 0) onRespond(value.trim());
            }}
          >
            <input
              autoFocus
              className="dialog-input"
              type={prompt.type === "secret" ? "password" : "text"}
              placeholder={prompt.placeholder ?? ""}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <div className="dialog-actions">
              <button type="submit" className="btn primary" disabled={value.trim().length === 0}>
                Submit
              </button>
            </div>
          </form>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={() => onRespond(null)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
