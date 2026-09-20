/**
 * JSONL framing for pi's RPC mode.
 *
 * Protocol rules (packages/coding-agent/docs/rpc.md):
 * - LF is the only record delimiter;
 * - a trailing CR is stripped, so CRLF input is accepted;
 * - U+2028 / U+2029 are **not** delimiters — which is why the docs explicitly
 *   call out Node's `readline` as non-compliant. We therefore never use a
 *   generic line reader and split on LF ourselves.
 */

export const RECORD_DELIMITER = "\n";

const DEFAULT_MAX_RECORD_LENGTH = 8 * 1024 * 1024;

export class RpcFrameError extends Error {
  /** The offending record, truncated, for diagnostics. */
  readonly record: string;

  constructor(message: string, record: string) {
    super(message);
    this.name = "RpcFrameError";
    this.record = record;
  }
}

/**
 * Encode one command as an LF-terminated record. U+2028 / U+2029 are escaped:
 * JSON-equivalent, but safe even if the peer used a Unicode-aware line reader.
 */
export function encodeRecord(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new RpcFrameError("value is not JSON-serializable", String(value));
  }
  return json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029") + RECORD_DELIMITER;
}

export interface DecodeOutcome {
  readonly records: readonly unknown[];
  readonly errors: readonly RpcFrameError[];
}

const EMPTY_OUTCOME: DecodeOutcome = Object.freeze({ records: [], errors: [] });

export interface JsonlDecoderOptions {
  readonly maxRecordLength?: number;
}

/** Incremental JSONL decoder. Handles arbitrary chunk boundaries. */
export class JsonlDecoder {
  #buffer = "";
  #discarding = false;
  readonly #maxRecordLength: number;

  constructor(options: JsonlDecoderOptions = {}) {
    this.#maxRecordLength = options.maxRecordLength ?? DEFAULT_MAX_RECORD_LENGTH;
  }

  get bufferedLength(): number {
    return this.#buffer.length;
  }

  push(chunk: string): DecodeOutcome {
    if (chunk.length === 0) return EMPTY_OUTCOME;
    this.#buffer += chunk;

    const records: unknown[] = [];
    const errors: RpcFrameError[] = [];
    let start = 0;
    for (;;) {
      const newlineAt = this.#buffer.indexOf(RECORD_DELIMITER, start);
      if (newlineAt === -1) break;
      this.#consume(this.#buffer.slice(start, newlineAt), records, errors);
      start = newlineAt + 1;
    }
    this.#buffer = this.#buffer.slice(start);

    if (this.#buffer.length > this.#maxRecordLength) {
      errors.push(
        new RpcFrameError(`record exceeds ${this.#maxRecordLength} chars, dropped`, preview(this.#buffer)),
      );
      this.#buffer = "";
      this.#discarding = true;
    }

    return { records, errors };
  }

  /** Signal end of input. A leftover partial record is reported as an error. */
  end(): DecodeOutcome {
    const rest = this.#buffer;
    this.#buffer = "";
    const wasDiscarding = this.#discarding;
    this.#discarding = false;
    if (rest.length === 0 || wasDiscarding) return EMPTY_OUTCOME;
    return { records: [], errors: [new RpcFrameError("incomplete record at end of stream", preview(rest))] };
  }

  #consume(raw: string, records: unknown[], errors: RpcFrameError[]): void {
    if (this.#discarding) {
      // Swallow everything until the next delimiter after an oversized record.
      this.#discarding = false;
      return;
    }
    const record = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (record.trim().length === 0) return; // tolerate blank lines
    if (record.length > this.#maxRecordLength) {
      errors.push(
        new RpcFrameError(`record exceeds ${this.#maxRecordLength} chars, dropped`, preview(record)),
      );
      return;
    }
    try {
      records.push(JSON.parse(record) as unknown);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(new RpcFrameError(`record is not valid JSON: ${detail}`, preview(record)));
    }
  }
}

function preview(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 200)}…`;
}
