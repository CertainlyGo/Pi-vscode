import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAuthPath, loadAuthFile, maskKey, removeCredential, saveCredential } from "../src/providers/auth-store";
import {
  getModelsPath,
  listModelProviders,
  removeProvider,
  setCustomProvider,
  setProviderBaseUrl,
} from "../src/providers/models-config";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-vscode-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("auth.json round-trips and preserves other providers", async () => {
  await withTempDir(async (dir) => {
    const path = getAuthPath(dir);
    await saveCredential(path, "openai", { type: "api_key", key: "sk-one" });
    await saveCredential(path, "anthropic", { type: "api_key", key: "sk-ant" });
    let auth = await loadAuthFile(path);
    assert.equal(Object.keys(auth).length, 2);
    assert.equal(auth["openai"]?.type, "api_key");

    assert.equal(await removeCredential(path, "openai"), true);
    assert.equal(await removeCredential(path, "openai"), false);
    auth = await loadAuthFile(path);
    assert.deepEqual(Object.keys(auth), ["anthropic"]);

    const raw = await readFile(path, "utf8");
    assert.match(raw, /"anthropic"/);
    assert.doesNotMatch(raw, /sk-one/);
  });
});

test("auth.json rejects corrupt files instead of overwriting", async () => {
  await withTempDir(async (dir) => {
    const path = getAuthPath(dir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{ not json", "utf8");
    await assert.rejects(() => loadAuthFile(path));
  });
});

test("models.json merges custom providers without clobbering", async () => {
  await withTempDir(async (dir) => {
    const path = getModelsPath(dir);
    await setProviderBaseUrl(path, "openai", "https://gateway.example.com/v1");
    await setCustomProvider(path, "my-vllm", {
      baseUrl: "http://localhost:8000/v1",
      api: "openai-completions",
      models: ["qwen2.5-coder:7b"],
    });
    await setCustomProvider(path, "my-vllm", {
      baseUrl: "http://localhost:8000/v1",
      api: "openai-completions",
      models: ["llama3.1:8b", "qwen2.5-coder:7b"],
    });

    const providers = await listModelProviders(path);
    const openai = providers.find((provider) => provider.id === "openai");
    assert.equal(openai?.baseUrl, "https://gateway.example.com/v1");

    const vllm = providers.find((provider) => provider.id === "my-vllm");
    assert.deepEqual([...(vllm?.models ?? [])].sort(), ["llama3.1:8b", "qwen2.5-coder:7b"]);
    assert.equal(vllm?.api, "openai-completions");

    await removeProvider(path, "openai");
    const remaining = await listModelProviders(path);
    assert.deepEqual(
      remaining.map((provider) => provider.id),
      ["my-vllm"],
    );
  });
});

test("masks keys without leaking them", () => {
  assert.equal(maskKey("sk-1234567890abcdef"), "sk-1…cdef");
  assert.equal(maskKey("short"), "••••");
});
