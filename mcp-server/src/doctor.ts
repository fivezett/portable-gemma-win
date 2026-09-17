import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { baseUrl, type Config } from "./config.ts";
import { LlamaServer } from "./llama.ts";
import { isWindows, paths } from "./paths.ts";

type Check = { label: string; ok: boolean | null; detail: string };

function mark(ok: boolean | null): string {
  if (ok === null) return "--";
  return ok ? "OK" : "NG";
}

async function run(command: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const text = `${out}${err}`.trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

function directorySize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export async function doctor(config: Config): Promise<number> {
  const checks: Check[] = [];

  checks.push({ label: "Application root", ok: true, detail: paths.root });

  const binaryExists = existsSync(config.server.binary);
  const version = binaryExists ? await run(config.server.binary, ["--version"]) : null;
  checks.push({
    label: "llama-server",
    ok: binaryExists,
    detail: binaryExists
      ? `${config.server.binary}${version ? `\n    ${version.split(/\r?\n/)[0] ?? ""}` : ""}`
      : `not found at ${config.server.binary} -- run scripts/fetch-runtime.ps1`,
  });

  if (isWindows) {
    const cudart = existsSync(paths.runtimeDir)
      ? readdirSync(paths.runtimeDir).filter((name) => /^(cudart|cublas|cublasLt)/i.test(name))
      : [];
    checks.push({
      label: "CUDA runtime DLLs",
      ok: cudart.length > 0,
      detail:
        cudart.length > 0
          ? cudart.slice(0, 4).join(", ")
          : "no cudart/cublas DLLs in runtime/llama -- inference will fall back to CPU",
    });
  }

  const gpu = await run("nvidia-smi", [
    "--query-gpu=name,compute_cap,memory.total,driver_version",
    "--format=csv,noheader",
  ]);
  checks.push({
    label: "GPU",
    ok: gpu !== null,
    detail: gpu ?? "cannot run nvidia-smi (no NVIDIA driver, or no GPU)",
  });

  if (gpu) {
    const capText = gpu.split(",")[1]?.trim() ?? "";
    const cap = Number(capText);
    if (Number.isFinite(cap)) {
      checks.push({
        label: "CUDA 13 support",
        ok: cap >= 7.5,
        detail:
          cap >= 7.5
            ? `compute capability ${capText} -- cuda-13.x builds work`
            : `compute capability ${capText} -- CUDA 13 dropped this GPU; use fetch-runtime.ps1 -Cuda 12`,
      });
    }
  }

  const modelBytes = directorySize(paths.modelsDir);
  checks.push({
    label: "Model",
    ok: modelBytes > 0 ? true : null,
    detail:
      modelBytes > 0
        ? `${paths.modelsDir} (${formatGiB(modelBytes)})`
        : `not downloaded yet; ${config.model.hf} is fetched on first use`,
  });

  const llama = new LlamaServer(config);
  const healthy = await llama.health();
  const props = healthy ? await llama.props() : null;
  checks.push({
    label: "llama-server health",
    ok: healthy ? true : null,
    detail: healthy
      ? `answering at ${baseUrl(config)}${props?.model ? ` / model=${props.model}` : ""}`
      : `${baseUrl(config)} is down (it starts on the first tool call)`,
  });

  checks.push({
    label: "Config file",
    ok: existsSync(paths.configFile) ? true : null,
    detail: existsSync(paths.configFile) ? paths.configFile : "not present; defaults apply",
  });

  const lines = checks.map((check) => `  [${mark(check.ok)}] ${check.label}: ${check.detail}`);
  process.stdout.write(`gemma-mcp diagnostics\n${lines.join("\n")}\n`);

  return checks.some((check) => check.ok === false) ? 1 : 0;
}
