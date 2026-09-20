import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import type {
  AssistantItem,
  Attachment,
  BashItem,
  ChatItem,
  CompactionItem,
  NoteItem,
  UserItem,
} from "../../../src/shared/protocol";
import { copyText } from "../clipboard";
import { renderMarkdown } from "../markdown";
import { Icon } from "./Icons";
import type { IconName } from "./Icons";

export interface MessageItemProps {
  readonly item: ChatItem;
  readonly onFork: (entryId: string) => void;
  readonly onOpenFile: (path: string, line?: number) => void;
}

export function MessageItem(props: MessageItemProps): JSX.Element | null {
  const { item } = props;
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} onFork={props.onFork} />;
    case "assistant":
      return <AssistantMessage item={item} />;
    case "note":
      return <NoteMessage item={item} />;
    case "compaction":
      return <CompactionMessage item={item} />;
    case "bash":
      return <BashMessage item={item} onOpenFile={props.onOpenFile} />;
    default:
      return null;
  }
}

function UserMessage({ item, onFork }: { item: UserItem; onFork: (entryId: string) => void }): JSX.Element {
  return (
    <div className="msg msg-user">
      <div className="msg-user-inner">
        {item.text.length > 0 && <div className="user-text">{item.text}</div>}
        {item.attachments.length > 0 && (
          <div className="attachment-chips">
            {item.attachments.map((attachment, index) => (
              <span key={index} className="attachment-chip static">
                <Icon name={attachment.kind === "selection" ? "diff" : "file"} size={12} />
                {attachment.label || attachment.path}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="msg-actions">
        <button type="button" className="icon-btn" title="Copy" onClick={() => void copyText(item.text)}>
          <Icon name="copy" size={14} />
        </button>
        {item.entryId !== undefined && (
          <button
            type="button"
            className="icon-btn"
            title="Branch from here"
            onClick={() => onFork(item.entryId ?? "")}
          >
            <Icon name="branch" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function AssistantMessage({ item }: { item: AssistantItem }): JSX.Element {
  const text = useThrottled(item.text, item.streaming ? 80 : 0);
  const html = useMemo(() => (text.length > 0 ? renderMarkdown(text) : ""), [text]);
  const [showThinking, setShowThinking] = useState(false);

  return (
    <div className="msg msg-assistant">
      {item.thinking.length > 0 && (
        <div className="thinking">
          <button type="button" className="thinking-head" onClick={() => setShowThinking((value) => !value)}>
            <Icon name="brain" size={13} />
            <span>Thinking</span>
            <Icon name={showThinking ? "chevron-down" : "chevron-right"} size={13} />
          </button>
          {showThinking && <div className="thinking-body">{item.thinking}</div>}
        </div>
      )}
      {item.error !== undefined && (
        <div className="callout error">
          <Icon name="error" size={14} />
          <span>{item.error}</span>
        </div>
      )}
      {html.length > 0 && <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />}
      {item.streaming && <span className="stream-cursor" />}
      {!item.streaming && item.text.length > 0 && (
        <div className="msg-actions left">
          <button type="button" className="icon-btn" title="Copy" onClick={() => void copyText(item.text)}>
            <Icon name="copy" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function NoteMessage({ item }: { item: NoteItem }): JSX.Element {
  const icon: IconName =
    item.level === "error" ? "error" : item.level === "warn" ? "warning" : item.level === "success" ? "check" : "info";
  return (
    <div className={`callout ${item.level}`}>
      <Icon name={icon} size={14} />
      <div className="callout-body">
        <span>{item.text}</span>
        {item.detail !== undefined && <pre className="callout-detail">{item.detail}</pre>}
      </div>
    </div>
  );
}

function CompactionMessage({ item }: { item: CompactionItem }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="compaction">
      <button type="button" className="compaction-head" onClick={() => setExpanded((value) => !value)}>
        <Icon name={item.streaming ? "spinner" : "history"} size={14} />
        <span>Context compacted</span>
        {item.tokensBefore !== undefined && item.tokensAfter !== undefined && (
          <span className="compaction-tokens">
            {formatTokens(item.tokensBefore)} → {formatTokens(item.tokensAfter)}
          </span>
        )}
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={13} />
      </button>
      {expanded && <div className="compaction-body">{item.text}</div>}
    </div>
  );
}

function BashMessage({ item, onOpenFile }: { item: BashItem; onOpenFile: (path: string, line?: number) => void }): JSX.Element {
  return (
    <div className={`tool tool-${item.streaming ? "running" : item.exitCode === 0 ? "ok" : "error"}`}>
      <div className="tool-head static">
        <span className="tool-icon">
          <Icon name="terminal" size={14} />
        </span>
        <span className="tool-label">Bash</span>
        <span className="tool-target">{item.command}</span>
        {item.exitCode !== undefined && <span className="tool-duration">exit {item.exitCode}</span>}
      </div>
      {item.output.length > 0 && <pre className="tool-output">{item.output}</pre>}
      {item.fullOutputPath !== undefined && (
        <div className="tool-actions">
          <button type="button" className="link-btn" onClick={() => onOpenFile(item.fullOutputPath ?? "")}>
            Full output
          </button>
        </div>
      )}
    </div>
  );
}

function formatTokens(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

/**
 * Debounce a rapidly changing value so markdown is not re-parsed on every
 * streamed token. Pass `interval = 0` to use the value immediately.
 */
function useThrottled(value: string, interval: number): string {
  const [throttled, setThrottled] = useState(value);
  useEffect(() => {
    if (interval <= 0) {
      setThrottled(value);
      return undefined;
    }
    const timer = window.setTimeout(() => setThrottled(value), interval);
    return () => window.clearTimeout(timer);
  }, [value, interval]);
  return interval <= 0 ? value : throttled;
}

export type { Attachment };
