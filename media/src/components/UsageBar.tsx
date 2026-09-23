import type { JSX } from "react";
import type { Meta, UsageStats } from "../../../src/shared/protocol";
import { Icon } from "./Icons";

export interface UsageBarProps {
  readonly meta: Meta;
  readonly onCompact: () => void;
}

/**
 * Live session telemetry: prompt/completion tokens, cache hit rate, context
 * window pressure and a button to compact the conversation on demand.
 */
export function UsageBar({ meta, onCompact }: UsageBarProps): JSX.Element {
  const stats = meta.stats;
  const ready = meta.engine === "ready";
  const busy = meta.isStreaming || meta.isCompacting;
  const percent = clampPercent(stats?.contextPercent);
  const cacheRate = stats !== null ? cacheHitRate(stats) : null;

  return (
    <div className={`usage-bar ${stats?.live === true ? "live" : ""}`}>
      <span className="usage-item" title={uploadTitle(stats)}>
        <span className="usage-arrow up">↑</span>
        <span className="usage-value">{stats !== null ? formatTokens(promptTokens(stats)) : "—"}</span>
      </span>

      <span className="usage-item" title={downloadTitle(stats)}>
        <span className="usage-arrow down">↓</span>
        <span className="usage-value">{stats !== null ? formatTokens(stats.output) : "—"}</span>
      </span>

      <span className="usage-item" title={cacheTitle(stats)}>
        <span className="usage-glyph">⚡</span>
        <span className="usage-value">{cacheRate !== null ? `${Math.round(cacheRate)}%` : "—"}</span>
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

function promptTokens(stats: UsageStats): number {
  return stats.input + stats.cacheRead + stats.cacheWrite;
}

/** Cache reads over all prompt tokens; 0 means nothing was served from cache. */
function cacheHitRate(stats: UsageStats): number | null {
  const prompt = promptTokens(stats);
  if (prompt <= 0) return null;
  return (stats.cacheRead / prompt) * 100;
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

function uploadTitle(stats: UsageStats | null): string {
  if (stats === null) return "Prompt tokens sent to the model";
  return [
    `Uploaded ${stats.input.toLocaleString()} new input tokens`,
    `${stats.cacheRead.toLocaleString()} read from cache`,
    `${stats.cacheWrite.toLocaleString()} written to cache`,
  ].join("\n");
}

function downloadTitle(stats: UsageStats | null): string {
  if (stats === null) return "Completion tokens received from the model";
  return `Downloaded ${stats.output.toLocaleString()} output tokens`;
}

function cacheTitle(stats: UsageStats | null): string {
  if (stats === null) return "Prompt cache hit rate";
  const rate = cacheHitRate(stats);
  if (rate === null) return "Prompt cache hit rate: no prompt tokens yet";
  return `Prompt cache hit rate ${rate.toFixed(1)}%\n${stats.cacheRead.toLocaleString()} of ${promptTokens(
    stats,
  ).toLocaleString()} prompt tokens served from cache`;
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
