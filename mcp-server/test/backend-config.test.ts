import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setBackend, setTomlValue } from "../src/backend-config.ts";
import { backendDefaults } from "../src/config.ts";

/**
 * The installer picks a backend and writes it here, so this edit has to leave a
 * hand-written configuration otherwise untouched: comments included, since they are what
 * make the shipped file worth reading.
 */

describe("setTomlValue", () => {
  const sample = [
    "# leading comment",
    "",
    "[model]",
    "# which model",
    'hf = "old/model:Q4"',
    'alias = "gemma"',
    "",
    "[runtime]",
    "# which backend",
    'backend = "cuda"',
    "ctx = 16384",
    "",
  ].join("\n");

  test("replaces a value in place and changes nothing else", () => {
    const result = setTomlValue(sample, "runtime", "backend", "openvino");
    expect(result).toBe(sample.replace('backend = "cuda"', 'backend = "openvino"'));
  });

  test("only touches the named section", () => {
    const collision = ['[a]', 'name = "one"', "", "[b]", 'name = "two"'].join("\n");
    expect(setTomlValue(collision, "b", "name", "changed")).toBe(
      ['[a]', 'name = "one"', "", "[b]", 'name = "changed"'].join("\n"),
    );
  });

  test("adds the key under the header when the section lacks it", () => {
    const result = setTomlValue('[runtime]\nctx = 4096\n', "runtime", "backend", "openvino");
    expect(result).toBe('[runtime]\nbackend = "openvino"\nctx = 4096\n');
  });

  test("appends the section when it is missing entirely", () => {
    const result = setTomlValue('[model]\nalias = "gemma"\n', "runtime", "backend", "cuda");
    expect(result).toContain('[model]');
    expect(result).toContain('[runtime]\nbackend = "cuda"');
  });

  test("leaves a commented-out key alone", () => {
    const commented = '[runtime]\n# backend = "openvino"\nctx = 1\n';
    const result = setTomlValue(commented, "runtime", "backend", "cuda");
    expect(result).toContain('# backend = "openvino"');
    expect(result).toContain('backend = "cuda"');
  });

  test("escapes a value that would otherwise break the quoting", () => {
    const result = setTomlValue('[model]\npath = ""\n', "model", "path", 'C:\\models\\"odd".gguf');
    expect(Bun.TOML.parse(result)).toEqual({ model: { path: 'C:\\models\\"odd".gguf' } });
  });
});

describe("setBackend", () => {
  function withConfig(body: string, run: (file: string) => void): string {
    const dir = mkdtempSync(join(tmpdir(), "gemma-backend-"));
    const file = join(dir, "gemma.toml");
    writeFileSync(file, body);
    try {
      run(file);
      return readFileSync(file, "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("switches the model when it still holds the other backend's default", () => {
    const before = `[model]\nhf = ${JSON.stringify(backendDefaults.cuda.modelHf)}\n\n[runtime]\nbackend = "cuda"\n`;
    const after = withConfig(before, (file) => {
      const change = setBackend("openvino", file);
      expect(change.modelHf).toBe(backendDefaults.openvino.modelHf);
      expect(change.created).toBe(false);
    });

    expect(after).toContain('backend = "openvino"');
    expect(after).toContain(backendDefaults.openvino.modelHf);
  });

  test("never overwrites a model the user chose", () => {
    const before = '[model]\nhf = "someone/their-own-model:Q5_K_M"\n\n[runtime]\nbackend = "cuda"\n';
    const after = withConfig(before, (file) => {
      expect(setBackend("openvino", file).modelHf).toBeNull();
    });

    expect(after).toContain('backend = "openvino"');
    expect(after).toContain("someone/their-own-model:Q5_K_M");
  });

  test("switching back restores the CUDA default", () => {
    const before = `[model]\nhf = ${JSON.stringify(backendDefaults.openvino.modelHf)}\n\n[runtime]\nbackend = "openvino"\n`;
    const after = withConfig(before, (file) => {
      expect(setBackend("cuda", file).modelHf).toBe(backendDefaults.cuda.modelHf);
    });

    expect(after).toContain('backend = "cuda"');
    expect(after).toContain(backendDefaults.cuda.modelHf);
  });

  test("the result still parses as TOML", () => {
    const before = `[model]\nhf = ${JSON.stringify(backendDefaults.cuda.modelHf)}\n\n[runtime]\nbackend = "cuda"\nctx = 16384\n`;
    const after = withConfig(before, (file) => setBackend("openvino", file));
    const parsed = Bun.TOML.parse(after) as { runtime: { backend: string; ctx: number } };

    expect(parsed.runtime.backend).toBe("openvino");
    expect(parsed.runtime.ctx).toBe(16384);
  });
});
