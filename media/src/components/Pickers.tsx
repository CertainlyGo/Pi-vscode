import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import type { Meta } from "../../../src/shared/protocol";
import { Icon } from "./Icons";

function useOutsideClose(open: boolean, close: () => void): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

export interface ModelPickerProps {
  readonly meta: Meta;
  readonly onSelectModel: (provider: string, modelId: string) => void;
  readonly onSelectThinking: (level: string) => void;
}

export function ModelPicker({ meta, onSelectModel, onSelectThinking }: ModelPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));

  const grouped = new Map<string, typeof meta.models[number][]>();
  for (const model of meta.models) {
    const list = grouped.get(model.provider) ?? [];
    list.push(model);
    grouped.set(model.provider, list);
  }

  const label = meta.model?.name ?? (meta.models.length > 0 ? "Select model" : "No models");

  return (
    <div className="picker" ref={ref}>
      <button type="button" className="pill" onClick={() => setOpen((value) => !value)}>
        <Icon name="sparkle" size={13} />
        <span className="pill-label">{label}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="popover model-popover">
          <div className="popover-head">Model</div>
          {meta.models.length === 0 && (
            <div className="popover-empty">
              No models available. Use the key button in the header to add a credential or model source.
            </div>
          )}
          {[...grouped].map(([provider, models]) => (
            <div key={provider} className="model-group">
              <div className="model-provider">{provider}</div>
              {models.map((model) => {
                const active = meta.model?.id === model.id && meta.model?.provider === model.provider;
                return (
                  <button
                    key={`${model.provider}/${model.id}`}
                    type="button"
                    className={`model-row ${active ? "active" : ""}`}
                    onClick={() => {
                      onSelectModel(model.provider, model.id);
                      setOpen(false);
                    }}
                  >
                    <span className="model-name">{model.name}</span>
                    {model.reasoning === true && <span className="badge">reasoning</span>}
                    {active && <Icon name="check" size={13} />}
                  </button>
                );
              })}
            </div>
          ))}

          {meta.thinkingLevels.length > 1 && (
            <>
              <div className="popover-head separated">Thinking</div>
              <div className="thinking-levels">
                {meta.thinkingLevels.map((level) => (
                  <button
                    key={level}
                    type="button"
                    className={`level-btn ${meta.thinkingLevel === level ? "active" : ""}`}
                    onClick={() => onSelectThinking(level)}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </>
          )}

        </div>
      )}
    </div>
  );
}

export interface SessionPickerProps {
  readonly meta: Meta;
  /** Display title for the active session (already derived by the caller). */
  readonly title: string;
  readonly onSwitch: (path: string) => void;
  readonly onDelete: (path: string) => void;
  readonly onRename: (name: string) => void;
}

export function SessionPicker(props: SessionPickerProps): JSX.Element {
  const { meta } = props;
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useOutsideClose(open, () => {
    setOpen(false);
    setRenaming(false);
  });

  const title = props.title;

  return (
    <div className="picker" ref={ref}>
      <button type="button" className="session-button" title="Sessions" onClick={() => setOpen((value) => !value)}>
        <Icon name="history" size={14} />
        <span className="session-title">{title}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="popover session-popover">
          <div className="session-actions">
            {renaming ? (
              <form
                className="rename-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (draft.trim().length > 0) props.onRename(draft.trim());
                  setRenaming(false);
                }}
              >
                <input
                  autoFocus
                  value={draft}
                  placeholder="Session name"
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="submit" className="link-btn">
                  Save
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setDraft(title === "New session" ? "" : title);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
            )}
          </div>
          <div className="session-list">
            {meta.sessions.length === 0 && <div className="popover-empty">No saved sessions yet.</div>}
            {meta.sessions.map((session) => {
              const active = meta.sessionFile === session.path;
              return (
                <div key={session.path} className={`session-row ${active ? "active" : ""}`}>
                  <button
                    type="button"
                    className="session-row-main"
                    onClick={() => {
                      props.onSwitch(session.path);
                      setOpen(false);
                    }}
                  >
                    <span className="session-row-name">{session.name}</span>
                    <span className="session-row-time">{formatTime(session.updatedAt)}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    title="Delete session"
                    onClick={() => props.onDelete(session.path)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function formatTime(millis: number): string {
  const date = new Date(millis);
  const now = Date.now();
  const diff = now - millis;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return date.toLocaleDateString();
}
