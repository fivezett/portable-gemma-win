import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { buildServerArgs, buildServerEnv } from "../src/llama.ts";

/**
 * Backend selection decides which binary runs and which device it runs on. A wrong flag or
 * a missing environment variable does not fail loudly — it just runs somewhere slower than
 * intended — so the shape of both is asserted directly.
 */

/** Load a config from environment overrides alone, ignoring any config file on disk. */
function configFrom(overrides: Record<string, string>) {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return loadConfig("/nonexistent/gemma.toml");
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Value that follows a flag in an argument list. */
function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("CUDA backend", () => {
  const config = configFrom({ GEMMA_BACKEND: "cuda", GEMMA_NGL: "99", GEMMA_CTX: "16384" });

  test("offloads layers to the GPU", () => {
    const args = buildServerArgs(config);
    expect(argValue(args, "-ngl")).toBe("99");
    expect(argValue(args, "-c")).toBe("16384");
  });

  test("keeps warmup", () => {
    expect(buildServerArgs(config)).not.toContain("--no-warmup");
  });

  test("sets no OpenVINO variables", () => {
    const env = buildServerEnv(config, {});
    expect(env.GGML_OPENVINO_DEVICE).toBeUndefined();
    expect(env.GGML_OPENVINO_STATEFUL_EXECUTION).toBeUndefined();
    expect(env.LLAMA_CACHE).toBeDefined();
  });
});

describe("OpenVINO backend", () => {
  test("drops -ngl, which the backend ignores, and skips warmup", () => {
    const args = buildServerArgs(configFrom({ GEMMA_BACKEND: "openvino" }));
    expect(args).not.toContain("-ngl");
    expect(args).toContain("--no-warmup");
  });

  test("selects the device and leaves stateful execution off", () => {
    // Gemma 4 is reported as failing with stateful execution on CPU and GPU.
    const env = buildServerEnv(configFrom({ GEMMA_BACKEND: "openvino", GEMMA_OPENVINO_DEVICE: "gpu" }), {});
    expect(env.GGML_OPENVINO_DEVICE).toBe("GPU");
    expect(env.GGML_OPENVINO_STATEFUL_EXECUTION).toBe("0");
  });

  test("points the compiled-model cache inside the app folder", () => {
    const env = buildServerEnv(configFrom({ GEMMA_BACKEND: "openvino" }), {});
    expect(env.GGML_OPENVINO_CACHE_DIR).toContain("openvino");
    expect(env.GGML_OPENVINO_COMPILED_MODEL_CACHE_DIR).toBe(env.GGML_OPENVINO_CACHE_DIR);
  });

  test("leaves the cache unset on NPU, which cannot use it, and sets the prefill chunk", () => {
    const env = buildServerEnv(
      configFrom({ GEMMA_BACKEND: "openvino", GEMMA_OPENVINO_DEVICE: "NPU", GEMMA_CTX: "1024" }),
      {},
    );
    expect(env.GGML_OPENVINO_CACHE_DIR).toBeUndefined();
    expect(env.GGML_OPENVINO_PREFILL_CHUNK_SIZE).toBe("256");
  });

  test("forces a single slot when stateful execution is on", () => {
    // llama-server only serves one chat session in that mode.
    const args = buildServerArgs(
      configFrom({ GEMMA_BACKEND: "openvino", GEMMA_OPENVINO_STATEFUL: "1", GEMMA_PARALLEL: "4" }),
    );
    expect(argValue(args, "-np")).toBe("1");
  });

  test("honours the configured slot count when stateless", () => {
    const args = buildServerArgs(configFrom({ GEMMA_BACKEND: "openvino", GEMMA_PARALLEL: "4" }));
    expect(argValue(args, "-np")).toBe("4");
  });

  test("looks for llama-server in the OpenVINO runtime folder", () => {
    const config = configFrom({ GEMMA_BACKEND: "openvino" });
    expect(config.server.binary).toContain("llama-openvino");
  });
});
