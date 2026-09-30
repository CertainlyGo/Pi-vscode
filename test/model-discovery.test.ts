import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { saveCredential } from "../src/providers/auth-store";
import { fetchEndpointModels, inferReasoning, modelsEndpoint, parseModelsResponse } from "../src/providers/model-discovery";
import { getModelsPath, listModelEntries, setCustomProvider } from "../src/providers/models-config";
import { ProviderService } from "../src/providers/provider-service";
import { getModelThinkingLevel, getSettingsPath, readSettings } from "../src/providers/settings-config";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-vscode-discovery-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("builds the model-list URL per API flavour", () => {
  assert.equal(modelsEndpoint("openai-completions", "https://api.openai.com/v1"), "https://api.openai.com/v1/models");
  assert.equal(modelsEndpoint("openai-completions", "http://localhost:8000/v1/"), "http://localhost:8000/v1/models");
  assert.equal(modelsEndpoint("anthropic-messages", "https://api.anthropic.com"), "https://api.anthropic.com/v1/models");
  assert.equal(
    modelsEndpoint("anthropic-messages", "https://gateway.example.com/v1"),
    "https://gateway.example.com/v1/models",
  );
  assert.equal(
    modelsEndpoint("google-generative-ai", "https://generativelanguage.googleapis.com/v1beta"),
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  assert.equal(modelsEndpoint("openai-responses", "https://x.test/v1/models"), "https://x.test/v1/models");
});

test("recognises reasoning model ids", () => {
  for (const id of ["o3-mini", "gpt-5.1", "claude-sonnet-4-20250514", "deepseek-r1", "qwen3-32b", "gemini-2.5-pro"]) {
    assert.equal(inferReasoning(id), true, id);
  }
  for (const id of ["gpt-4o-mini", "claude-3-5-sonnet", "llama-3.1-8b", "mistral-large"]) {
    assert.equal(inferReasoning(id), false, id);
  }
});

test("parses OpenAI, Anthropic and Google model payloads", () => {
  const openai = parseModelsResponse("openai-completions", {
    data: [
      { id: "gpt-4o-mini", name: "GPT-4o mini" },
      { id: "acme-reasoner", supported_parameters: ["tools", "reasoning"] },
      { id: "gpt-4o-mini" },
    ],
  });
  assert.deepEqual(
    openai.map((model) => model.id),
    ["gpt-4o-mini", "acme-reasoner"],
  );
  assert.equal(openai[0]?.reasoning, false);
  assert.equal(openai[1]?.reasoning, true);

  const anthropic = parseModelsResponse("anthropic-messages", {
    data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" }],
  });
  assert.equal(anthropic[0]?.id, "claude-sonnet-4-5");
  assert.equal(anthropic[0]?.name, "Claude Sonnet 4.5");
  assert.equal(anthropic[0]?.reasoning, true);

  const google = parseModelsResponse("google-generative-ai", {
    models: [{ name: "models/gemini-2.0-flash", displayName: "Gemini 2.0 Flash" }],
  });
  assert.equal(google[0]?.id, "gemini-2.0-flash");

  assert.deepEqual(parseModelsResponse("openai-completions", { models: ["a", "a", "b"] }).map((m) => m.id), ["a", "b"]);
});

test("fetchEndpointModels reports success and failures", async () => {
  const ok = await fetchEndpointModels({
    api: "openai-completions",
    baseUrl: "https://x.test/v1",
    key: "sk-test",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "o3" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok ? ok.models.map((m) => m.id) : [], ["m1", "o3"]);

  const bad = await fetchEndpointModels({
    api: "openai-completions",
    baseUrl: "https://x.test/v1",
    key: "sk-test",
    fetchImpl: (async () => new Response("nope", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.message, /401/);
});

test("ProviderService discovers endpoint models, stores reasoning and defaults depth to medium", async () => {
  await withTempDir(async (dir) => {
    await saveCredential(join(dir, "auth.json"), "my-gateway", { type: "api_key", key: "sk-gateway" });
    await setCustomProvider(getModelsPath(dir), "my-gateway", {
      baseUrl: "https://gateway.test/v1",
      api: "openai-completions",
      models: [],
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "plain-model" }, { id: "o4-mini" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      const service = new ProviderService({
        getAgentDir: () => dir,
        getLaunch: () => undefined,
        openExternal: () => undefined,
        log: () => undefined,
      });
      const outcome = await service.discoverModels("my-gateway");
      assert.equal(outcome.source, "endpoint");
      assert.deepEqual(
        outcome.models.map((model) => `${model.id}:${model.reasoning}:${model.thinkingLevel}`),
        ["plain-model:false:medium", "o4-mini:true:medium"],
      );

      const entries = await listModelEntries(getModelsPath(dir), "my-gateway");
      assert.deepEqual(entries, [{ id: "plain-model" }, { id: "o4-mini", reasoning: true }]);

      // pi's model-level depth map got the medium default for the reasoning model only.
      assert.equal(await getModelThinkingLevel(getSettingsPath(dir), "my-gateway", "o4-mini"), "medium");
      const settings = await readSettings(getSettingsPath(dir));
      assert.deepEqual(settings["modelThinkingLevels"], { "my-gateway/o4-mini": "medium" });

      // A second discovery must not duplicate entries or downgrade reasoning.
      await service.discoverModels("my-gateway");
      assert.equal((await listModelEntries(getModelsPath(dir), "my-gateway")).length, 2);

      // Explicit toggles are persisted both ways.
      await service.setModelReasoning("my-gateway", "o4-mini", false);
      assert.equal((await listModelEntries(getModelsPath(dir), "my-gateway"))[1]?.reasoning, false);
      const result = await service.setThinkingLevel("my-gateway", "o4-mini", "high");
      assert.equal(result.ok, true);
      assert.equal(await getModelThinkingLevel(getSettingsPath(dir), "my-gateway", "o4-mini"), "high");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ProviderService probes a built-in provider endpoint and merges it with pi's catalog", async () => {
  await withTempDir(async (dir) => {
    await saveCredential(join(dir, "auth.json"), "openrouter", { type: "api_key", key: "sk-or" });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "openai/gpt-4o", name: "GPT-4o" },
            { id: "acme/secret-reasoner", supported_parameters: ["reasoning"] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      const service = new ProviderService({
        getAgentDir: () => dir,
        getLaunch: () => undefined,
        openExternal: () => undefined,
        log: () => undefined,
      });
      const outcome = await service.discoverModels("openrouter", {
        catalogModels: [{ id: "openai/gpt-4o", reasoning: false, thinkingLevel: "medium" }],
      });
      assert.equal(outcome.source, "endpoint");
      assert.deepEqual(
        outcome.models.map((model) => model.id),
        ["openai/gpt-4o", "acme/secret-reasoner"],
      );

      // Only the endpoint-only model is written; the catalog model is untouched.
      assert.deepEqual(await listModelEntries(getModelsPath(dir), "openrouter"), [
        { id: "acme/secret-reasoner", reasoning: true },
      ]);

      // A discovered model is edited in place...
      await service.setModelReasoning("openrouter", "acme/secret-reasoner", false);
      assert.deepEqual(await listModelEntries(getModelsPath(dir), "openrouter"), [
        { id: "acme/secret-reasoner", reasoning: false },
      ]);

      // ...while a pure catalog model takes a non-destructive override.
      await service.setModelReasoning("openrouter", "openai/gpt-4o", true);
      const raw = JSON.parse(await readFile(getModelsPath(dir), "utf8")) as {
        providers: Record<string, { modelOverrides?: Record<string, unknown> }>;
      };
      assert.deepEqual(raw.providers["openrouter"]?.modelOverrides, {
        "openai/gpt-4o": { reasoning: true },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ProviderService prefers pi's catalog and annotates depths from settings", async () => {
  await withTempDir(async (dir) => {
    const service = new ProviderService({
      getAgentDir: () => dir,
      getLaunch: () => undefined,
      openExternal: () => undefined,
      log: () => undefined,
    });
    const outcome = await service.discoverModels("anthropic", {
      catalogModels: [
        { id: "claude-sonnet-4", reasoning: true, thinkingLevel: "medium" },
        { id: "claude-haiku-4", reasoning: false, thinkingLevel: "medium" },
      ],
    });
    assert.equal(outcome.source, "catalog");
    assert.equal(outcome.models.length, 2);
    const settings = JSON.parse(await readFile(getSettingsPath(dir), "utf8")) as Record<string, unknown>;
    assert.deepEqual(settings["modelThinkingLevels"], { "anthropic/claude-sonnet-4": "medium" });

    // Built-in models take a modelOverrides entry, not a shadowing models list.
    await service.setModelReasoning("anthropic", "claude-sonnet-4", false);
    const models = JSON.parse(await readFile(getModelsPath(dir), "utf8")) as {
      providers: Record<string, { models?: unknown; modelOverrides?: Record<string, unknown> }>;
    };
    assert.equal(models.providers["anthropic"]?.models, undefined);
    assert.deepEqual(models.providers["anthropic"]?.modelOverrides, { "claude-sonnet-4": { reasoning: false } });

    // The override must not divert discovery away from pi's catalog.
    const again = await service.discoverModels("anthropic", {
      catalogModels: [{ id: "claude-sonnet-4", reasoning: true, thinkingLevel: "medium" }],
    });
    assert.equal(again.source, "catalog");
  });
});
