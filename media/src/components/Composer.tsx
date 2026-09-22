import type { JSX } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, Meta, PromptMode, SlashCommand } from "../../../src/shared/protocol";
import type { Store } from "../store";
import { Icon } from "./Icons";
import { ModelPicker } from "./Pickers";

export interface ComposerProps {
  readonly meta: Meta;
  readonly files: readonly string[];
  readonly commands: readonly SlashCommand[];
  readonly store: Store;
  readonly onSend: (text: string, mode: PromptMode, attachments: readonly Attachment[]) => void;
  readonly onAbort: () => void;
  readonly onSetModel: (provider: string, modelId: string) => void;
  readonly onSetThinking: (level: string) => void;
  readonly onManageProviders: () => void;
}

interface Suggestion {
  readonly label: string;
  readonly detail?: string;
  readonly apply: () => void;
}

export const Composer = memo(function Composer(props: ComposerProps): JSX.Element {
  const { meta, files, commands, store } = props;
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [mode, setMode] = useState<Exclude<PromptMode, "send">>("steer");
  const [suggestions, setSuggestions] = useState<readonly Suggestion[]>([]);
  const [suggestionKind, setSuggestionKind] = useState<"file" | "command" | null>(null);
  const [highlight, setHighlight] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const ready = meta.engine === "ready";
  const streaming = meta.isStreaming;

  // Imperative messages from the host (editor commands, extension UI, focus).
  useEffect(
    () =>
      store.subscribeEffects((message) => {
        if (message.type === "attach") {
          setAttachments((current) =>
            current.some((entry) => entry.path === message.attachment.path && entry.kind === message.attachment.kind)
              ? current
              : [...current, message.attachment],
          );
        } else if (message.type === "setDraft") {
          setText(message.text);
        } else if (message.type === "insert") {
          setText((current) => (current.length > 0 ? `${current}\n${message.text}` : message.text));
        } else if (message.type === "focus") {
          textareaRef.current?.focus();
        }
      }),
    [store],
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 260)}px`;
  }, [text]);

  const updateSuggestions = (value: string): void => {
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const token = /(^|\s)([@/])([^\s@/]*)$/.exec(before);
    if (token === null) {
      setSuggestions([]);
      setSuggestionKind(null);
      return;
    }
    const sigil = token[2];
    const query = token[3] ?? "";
    if (sigil === "@") {
      const matches = fuzzyFilter(files, query, 8);
      setSuggestionKind("file");
      setHighlight(0);
      setSuggestions(
        matches.map((path) => ({
          label: path,
          apply: () => {
            setAttachments((current) =>
              current.some((entry) => entry.path === path) ? current : [...current, { kind: "file", path, label: path }],
            );
            setText((current) => replaceToken(current, caret, 1 + query.length));
          },
        })),
      );
      return;
    }
    const matches = fuzzyFilter(
      commands.map((command) => command.name),
      query,
      8,
    );
    setSuggestionKind("command");
    setHighlight(0);
    setSuggestions(
      matches.map((name) => {
        const command = commands.find((entry) => entry.name === name);
        return {
          label: `/${name}`,
          ...(command?.description !== undefined ? { detail: command.description } : {}),
          apply: () => {
            setText((current) => replaceToken(current, caret, 1 + query.length, `/${name} `));
            setSuggestions([]);
            setSuggestionKind(null);
          },
        };
      }),
    );
  };

  const submit = (): void => {
    const trimmed = text.trim();
    if (!ready || (trimmed.length === 0 && attachments.length === 0)) return;
    props.onSend(trimmed, streaming ? mode : "send", attachments);
    setText("");
    setAttachments([]);
    setSuggestions([]);
    setSuggestionKind(null);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((value) => (value + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((value) => (value - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        suggestions[highlight]?.apply();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSuggestions([]);
        setSuggestionKind(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const stats = useMemo(() => formatStats(meta), [meta]);

  return (
    <footer className="composer">
      {meta.queue.steering.length > 0 || meta.queue.followUp.length > 0 ? (
        <div className="queue">
          {meta.queue.steering.map((entry, index) => (
            <span key={`steer-${index}`} className="queue-chip steer">
              steer: {entry}
            </span>
          ))}
          {meta.queue.followUp.map((entry, index) => (
            <span key={`follow-${index}`} className="queue-chip follow">
              queue: {entry}
            </span>
          ))}
        </div>
      ) : null}

      <div className={`composer-box ${ready ? "" : "disabled"}`}>
        {attachments.length > 0 && (
          <div className="attachment-chips">
            {attachments.map((attachment, index) => (
              <span key={`${attachment.path}-${index}`} className="attachment-chip">
                <Icon name={attachment.kind === "selection" ? "diff" : "file"} size={12} />
                {attachment.label || attachment.path}
                <button
                  type="button"
                  className="chip-remove"
                  onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                >
                  <Icon name="close" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="suggestions">
            <div className="suggestions-head">{suggestionKind === "file" ? "Files" : "Commands"}</div>
            {suggestions.map((suggestion, index) => (
              <button
                key={suggestion.label}
                type="button"
                className={`suggestion ${index === highlight ? "active" : ""}`}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => suggestion.apply()}
              >
                <Icon name={suggestionKind === "file" ? "file" : "chip"} size={13} />
                <span className="suggestion-label">{suggestion.label}</span>
                {suggestion.detail !== undefined && <span className="suggestion-detail">{suggestion.detail}</span>}
              </button>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={ready ? "Ask pi to build, fix or explain…  (@ files, / commands)" : "Starting pi…"}
          disabled={!ready}
          onChange={(event) => {
            setText(event.target.value);
            updateSuggestions(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />

        <div className="composer-foot">
          <div className="composer-foot-left">
            <ModelPicker
              meta={meta}
              onSelectModel={props.onSetModel}
              onSelectThinking={props.onSetThinking}
              onManageProviders={props.onManageProviders}
            />
            {stats !== null && <span className="stats">{stats}</span>}
          </div>
          <div className="composer-foot-right">
            {streaming && (
              <div className="mode-toggle" title="How to handle a message while pi is working">
                <button
                  type="button"
                  className={mode === "steer" ? "active" : ""}
                  onClick={() => setMode("steer")}
                >
                  Steer
                </button>
                <button
                  type="button"
                  className={mode === "followUp" ? "active" : ""}
                  onClick={() => setMode("followUp")}
                >
                  Queue
                </button>
              </div>
            )}
            {streaming ? (
              <button type="button" className="send-btn stop" title="Stop" onClick={props.onAbort}>
                <Icon name="stop" size={15} />
              </button>
            ) : (
              <button
                type="button"
                className="send-btn"
                title="Send"
                disabled={!ready || (text.trim().length === 0 && attachments.length === 0)}
                onClick={submit}
              >
                <Icon name="send" size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </footer>
  );
});

function replaceToken(text: string, caret: number, tokenLength: number, replacement = ""): string {
  const before = text.slice(0, caret - tokenLength);
  const after = text.slice(caret);
  return `${before}${replacement}${after}`;
}

/** Cheap fuzzy match: subsequence first, substring preferred, ranked by position. */
function fuzzyFilter(values: readonly string[], query: string, limit: number): string[] {
  const needle = query.toLowerCase();
  if (needle.length === 0) return values.slice(0, limit);
  const scored: { value: string; score: number }[] = [];
  for (const value of values) {
    const haystack = value.toLowerCase();
    const index = haystack.indexOf(needle);
    if (index !== -1) {
      scored.push({ value, score: index });
      continue;
    }
    let cursor = 0;
    let gaps = 0;
    let matched = true;
    for (const char of needle) {
      const found = haystack.indexOf(char, cursor);
      if (found === -1) {
        matched = false;
        break;
      }
      gaps += found - cursor;
      cursor = found + 1;
    }
    if (matched) scored.push({ value, score: 100 + gaps });
  }
  scored.sort((a, b) => a.score - b.score || a.value.localeCompare(b.value));
  return scored.slice(0, limit).map((entry) => entry.value);
}

function formatStats(meta: Meta): string | null {
  const stats = meta.stats;
  if (stats === null || stats.totalTokens === 0) return null;
  const parts: string[] = [];
  parts.push(`${formatTokens(stats.totalTokens)} tok`);
  if (stats.contextPercent !== undefined && stats.contextPercent !== null) {
    parts.push(`ctx ${Math.round(stats.contextPercent)}%`);
  }
  if (stats.cost > 0) parts.push(`$${stats.cost.toFixed(2)}`);
  return parts.join(" · ");
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}
