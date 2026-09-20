import type { WebviewMessage } from "../../src/shared/protocol";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
  api.postMessage(message);
}

export function getPersistedState<T>(): T | undefined {
  return api.getState() as T | undefined;
}

export function setPersistedState(state: unknown): void {
  api.setState(state);
}
