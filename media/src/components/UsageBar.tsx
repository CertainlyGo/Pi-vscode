import type { JSX } from "react";
import type { Meta, UsageStats } from "../../../src/shared/protocol";
import { Icon } from "./Icons";

export interface UsageBarProps {
  readonly meta: Meta;
  readonly onCompact: () => void;
}

/**
 * Live session telemetry. Mirrors pi's TUI footer: `↑input`, `↓output`,
 * `R` cache reads, `W` cache writes and `CH` (the latest request's cache hit
 * rate) are five independent readouts. Nothing is folded into anything else,
 * so the numbers line up with what the TUI prints.
 */
export function UsageBar({ meta, onCompact }: UsageBarProps): JSX.Element {
  const stats = meta.stats;
  const ready = meta.engine === "ready";
  const busy = meta.isStreaming || meta.isCompacting;
  const percent = clampPercent(stats?.contextPercent);
  const cacheRate = stats?.cacheHitRate;
  const value = (count: number | undefined): string =>
    stats !== null && count !== undefined ? formatTokens(count) : "—";

  return (
    <div className={`usage-bar ${stats?.live === true ? "live" : ""}`}>
      <span className="usage-item" title={inputTitle(stats)}>
        <span className="usage-arrow up">↑</span>
        <span className="usage-value">{value(stats?.input)}</span>
      </span>

      <span className="usage-item" title={outputTitle(stats)}>
        <span className="usage-arrow down">↓</span>
        <span className="usage-value">{value(stats?.output)}</span>
      </span>

      <span className="usage-item" title={cacheReadTitle(stats)}>
        <span className="usage-glyph read">R</span>
        <span className="usage-value">{value(stats?.cacheRead)}</span>
      </span>

      <span className="usage-item" title={cacheWriteTitle(stats)}>
        <span className="usage-glyph write">W</span>
        <span className="usage-value">{value(stats?.cacheWrite)}</span>
      </span>

      <span className="usage-item" title={cacheHitTitle(stats)}>
        <span className="usage-glyph">CH</span>
        <span className="usage-value">
          {cacheRate !== undefined && Number.isFinite(cacheRate) ? `${cacheRate.toFixed(1)}%` : "—"}
        </span>
      </span>

      <span className="usage-context" title={contextTitle(stats)}>
        <span className="usage-value">{percent !== null ? `${Math.round(percent)}%` : "—"}</span>
        <span className={`usage-meter ${meterLevel(percent)}`}>
          <span className="usage-meter-fill" style={{ width: `${percent ?? 0}%` }} />
        </span>
        <span className="usage-context-detail">{contextDetail(stats)}</span>
      </span>

      {stats !== null && stats.cost > 0 && (
        <span className="usage-item" title={`Session cost $${stats.cost.toFixed(4)}`}>
          <span className="usage-value">${stats.cost.toFixed(2)}</span>
        </span>
      )}

      <button
        type="button"
        className="usage-compact"
        title={
          busy
            ? "Wait for the current run to finish before compacting"
            : "Compact the conversation to free context window"
        }
        disabled={!ready || busy}
        onClick={onCompact}
      >
        <Icon name="compact" size={12} />
        {meta.isCompacting ? "Compacting…" : "Compact"}
      </button>
    </div>
  );
}

function clampPercent(value: number | undefined): number | null {
  if (value === undefined || value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function meterLevel(percent: number | null): string {
  if (percent === null) return "idle";
  if (percent >= 85) return "high";
  if (percent >= 60) return "mid";
  return "low";
}

function contextDetail(stats: UsageStats | null): string {
  if (stats === null) return "context";
  if (stats.contextTokens !== undefined && stats.contextWindow !== undefined) {
    return `${formatTokens(stats.contextTokens)}/${formatTokens(stats.contextWindow)}`;
  }
  return "context";
}

function inputTitle(stats: UsageStats | null): string {
  const label = "New input tokens billed at the full rate; cache reads and writes are not included";
  if (stats === null) return label;
  return `↑ ${stats.input.toLocaleString()} — ${label.toLowerCase()}`;
}

function outputTitle(stats: UsageStats | null): string {
  if (stats === null) return "Completion tokens received from the model";
  return `↓ ${stats.output.toLocaleString()} output tokens`;
}

function cacheReadTitle(stats: UsageStats | null): string {
  if (stats === null) return "Prompt tokens served from the prompt cache";
  return `R ${stats.cacheRead.toLocaleString()} prompt tokens served from the prompt cache`;
}

function cacheWriteTitle(stats: UsageStats | null): string {
  if (stats === null) return "Prompt tokens written to the prompt cache";
  return `W ${stats.cacheWrite.toLocaleString()} prompt tokens written to the prompt cache`;
}

function cacheHitTitle(stats: UsageStats | null): string {
  const label = "Cache hit rate of the most recent request";
  if (stats === null) return label;
  const rate = stats.cacheHitRate;
  const prompt = stats.lastPromptTokens;
  if (rate === undefined || !Number.isFinite(rate)) {
    return `${label}: no prompt tokens reported yet`;
  }
  if (prompt === undefined || prompt <= 0) return `${label}: ${rate.toFixed(1)}%`;
  // `stats.cacheRead` is a session total, so recover the single request's
  // cache reads from the rate we already computed for exactly that request.
  const lastCacheRead = Math.round((rate / 100) * prompt);
  return [
    `${label}: ${rate.toFixed(1)}%`,
    `${lastCacheRead.toLocaleString()} of the last request's ${prompt.toLocaleString()} prompt tokens`,
    "were cache reads. This is a single-request rate, not a session average.",
  ].join("\n");
}

function contextTitle(stats: UsageStats | null): string {
  if (stats === null || stats.contextTokens === undefined || stats.contextWindow === undefined) {
    return "Context window usage";
  }
  const percent = clampPercent(stats.contextPercent);
  const left = Math.max(0, stats.contextWindow - stats.contextTokens);
  return [
    `Context ${formatTokens(stats.contextTokens)} / ${formatTokens(stats.contextWindow)}`,
    percent !== null ? `${percent.toFixed(1)}% used` : "",
    `${formatTokens(left)} tokens left before compaction`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}
