import { describe, it, expect, vi, afterEach } from "vitest";
import type { Env } from "../../env.d";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("createLLMProvider", () => {
  it("openai-raw uses OPENAI_BASE_URL for request URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "test",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    });

    vi.stubGlobal("fetch", fetchMock);

    const { createLLMProvider } = await import("./factory");
    const env = {
      OPENAI_API_KEY: "test",
      OPENAI_BASE_URL: "https://example.com/v1/",
      LLM_PROVIDER: "openai-raw",
    } as unknown as Env;

    const provider = createLLMProvider(env);
    expect(provider).not.toBeNull();

    await provider!.complete({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/v1/chat/completions",
      expect.any(Object)
    );
  });

  it("ai-sdk passes OPENAI_BASE_URL to @ai-sdk/openai createOpenAI", async () => {
    const createOpenAIMock = vi.fn(() => ((modelId: string) => ({ modelId })) as unknown as any);
    const createAnthropicMock = vi.fn(() => ((modelId: string) => ({ modelId })) as unknown as any);
    const createGoogleMock = vi.fn(() => ((modelId: string) => ({ modelId })) as unknown as any);
    const createXaiMock = vi.fn(() => ((modelId: string) => ({ modelId })) as unknown as any);
    const createDeepSeekMock = vi.fn(() => ((modelId: string) => ({ modelId })) as unknown as any);

    vi.doMock("@ai-sdk/openai", () => ({ createOpenAI: createOpenAIMock }));
    vi.doMock("@ai-sdk/anthropic", () => ({ createAnthropic: createAnthropicMock }));
    vi.doMock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: createGoogleMock }));
    vi.doMock("@ai-sdk/xai", () => ({ createXai: createXaiMock }));
    vi.doMock("@ai-sdk/deepseek", () => ({ createDeepSeek: createDeepSeekMock }));

    const { createLLMProvider } = await import("./factory");

    const env = {
      OPENAI_API_KEY: "test",
      OPENAI_BASE_URL: "https://proxy.example/v1/",
      LLM_PROVIDER: "ai-sdk",
      LLM_MODEL: "openai/gpt-4o-mini",
    } as unknown as Env;

    const provider = createLLMProvider(env);
    expect(provider).not.toBeNull();

    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: "test",
      baseURL: "https://proxy.example/v1",
    });
  });

  it("ignores whitespace OPENAI_BASE_URL", async () => {
    const createOpenAIMock = vi.fn(() => ((modelId: string) => ({ modelId })) as unknown as any);

    vi.doMock("@ai-sdk/openai", () => ({ createOpenAI: createOpenAIMock }));

    const { createLLMProvider } = await import("./factory");

    const env = {
      OPENAI_API_KEY: "test",
      OPENAI_BASE_URL: "   ",
      LLM_PROVIDER: "ai-sdk",
      LLM_MODEL: "openai/gpt-4o-mini",
    } as unknown as Env;

    const provider = createLLMProvider(env);
    expect(provider).not.toBeNull();

    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: "test",
    });
  });
});

