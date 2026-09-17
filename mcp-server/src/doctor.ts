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

  checks.push({ label: "アプリのルート", ok: true, detail: paths.root });

  const binaryExists = existsSync(config.server.binary);
  const version = binaryExists ? await run(config.server.binary, ["--version"]) : null;
  checks.push({
    label: "llama-server",
    ok: binaryExists,
    detail: binaryExists
      ? `${config.server.binary}${version ? `\n    ${version.split(/\r?\n/)[0] ?? ""}` : ""}`
      : `見つかりません: ${config.server.binary} → scripts/fetch-runtime.ps1 を実行してください`,
  });

  if (isWindows) {
    const cudart = existsSync(paths.runtimeDir)
      ? readdirSync(paths.runtimeDir).filter((name) => /^(cudart|cublas|cublasLt)/i.test(name))
      : [];
    checks.push({
      label: "CUDA ランタイム DLL",
      ok: cudart.length > 0,
      detail:
        cudart.length > 0
          ? cudart.slice(0, 4).join(", ")
          : "cudart/cublas の DLL が runtime/llama に見つかりません(CPU 実行になります)",
    });
  }

  const gpu = await run("nvidia-smi", [
    "--query-gpu=name,compute_cap,memory.total,driver_version",
    "--format=csv,noheader",
  ]);
  checks.push({
    label: "GPU",
    ok: gpu !== null,
    detail: gpu ?? "nvidia-smi を実行できません(NVIDIA ドライバ未導入か、GPU 非搭載)",
  });

  if (gpu) {
    const capText = gpu.split(",")[1]?.trim() ?? "";
    const cap = Number(capText);
    if (Number.isFinite(cap)) {
      checks.push({
        label: "CUDA 13 対応",
        ok: cap >= 7.5,
        detail:
          cap >= 7.5
            ? `compute capability ${capText} → cuda-13.x ビルドが使えます`
            : `compute capability ${capText} → CUDA 13 は非対応。fetch-runtime.ps1 -Cuda 12.4 を使ってください`,
      });
    }
  }

  const modelBytes = directorySize(paths.modelsDir);
  checks.push({
    label: "モデル",
    ok: modelBytes > 0 ? true : null,
    detail:
      modelBytes > 0
        ? `${paths.modelsDir} (${formatGiB(modelBytes)})`
        : `未取得。初回起動時に ${config.model.hf} を自動ダウンロードします`,
  });

  const llama = new LlamaServer(config);
  const healthy = await llama.health();
  const props = healthy ? await llama.props() : null;
  checks.push({
    label: "llama-server の応答",
    ok: healthy ? true : null,
    detail: healthy
      ? `${baseUrl(config)} で応答中${props?.model ? ` / model=${props.model}` : ""}`
      : `${baseUrl(config)} は停止中(ツール呼び出し時に自動起動します)`,
  });

  checks.push({
    label: "設定ファイル",
    ok: existsSync(paths.configFile) ? true : null,
    detail: existsSync(paths.configFile) ? paths.configFile : "未作成(既定値で動作します)",
  });

  const lines = checks.map((check) => `  [${mark(check.ok)}] ${check.label}: ${check.detail}`);
  process.stdout.write(`gemma-mcp 診断\n${lines.join("\n")}\n`);

  return checks.some((check) => check.ok === false) ? 1 : 0;
}
