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

/** Run a PowerShell one-liner; Windows only, and quiet about failure. */
async function powershell(script: string): Promise<string | null> {
  if (!isWindows) return null;
  return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
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

/** NVIDIA GPU and CUDA runtime checks. */
async function cudaChecks(config: Config): Promise<Check[]> {
  const checks: Check[] = [];

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

  void config;
  return checks;
}

/** OpenVINO runtime and Intel device checks. */
async function openvinoChecks(config: Config): Promise<Check[]> {
  const checks: Check[] = [];
  const dir = paths.openvinoRuntimeDir;

  const dlls = existsSync(dir) ? readdirSync(dir) : [];
  const core = dlls.filter((name) => /^openvino.*\.dll$/i.test(name));
  checks.push({
    label: "OpenVINO runtime DLLs",
    ok: core.length > 0,
    detail:
      core.length > 0
        ? `${core.length} DLLs in runtime/llama-openvino (${core.slice(0, 3).join(", ")}...)`
        : "no openvino*.dll in runtime/llama-openvino -- run fetch-runtime.ps1 -Backend openvino",
  });

  checks.push({
    label: "OpenVINO plugins.xml",
    ok: existsSync(join(dir, "plugins.xml")),
    detail: existsSync(join(dir, "plugins.xml"))
      ? join(dir, "plugins.xml")
      : "missing; device plugins cannot be loaded without it",
  });

  const device = config.openvino.device;
  checks.push({
    label: "Configured device",
    ok: true,
    detail: `${device}${config.openvino.stateful ? " (stateful execution ON)" : ""}`,
  });

  // Intel hardware detection, best effort. Absence is not proof: report, do not fail.
  const gpus = await powershell(
    "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join '; '",
  );
  checks.push({
    label: "Display adapters",
    ok: gpus ? null : null,
    detail: gpus ?? "could not enumerate (non-Windows, or WMI unavailable)",
  });

  const npu = await powershell(
    "((Get-PnpDevice -Class 'ComputeAccelerator' -Status OK -ErrorAction SilentlyContinue) | " +
      "Select-Object -ExpandProperty FriendlyName) -join '; '",
  );
  checks.push({
    label: "NPU",
    ok: npu ? true : null,
    detail: npu ?? "no compute accelerator reported (NPU absent, or the driver is not installed)",
  });

  if (device.startsWith("NPU") && config.runtime.ctx > 4096) {
    checks.push({
      label: "NPU context size",
      ok: false,
      detail: `runtime.ctx=${config.runtime.ctx} is large for the NPU; 1024-2048 is the safe range`,
    });
  }

  if (config.openvino.stateful) {
    checks.push({
      label: "Stateful execution",
      ok: false,
      detail:
        "Gemma 4 is reported as failing with stateful execution on CPU and GPU; " +
        "set openvino.stateful = false unless you have verified otherwise",
    });
  }

  return checks;
}

export async function doctor(config: Config): Promise<number> {
  const checks: Check[] = [];

  checks.push({ label: "Application root", ok: true, detail: paths.root });
  checks.push({ label: "Backend", ok: true, detail: config.runtime.backend });

  const binaryExists = existsSync(config.server.binary);
  const version = binaryExists ? await run(config.server.binary, ["--version"]) : null;
  const fetchHint =
    config.runtime.backend === "openvino"
      ? "run scripts/fetch-runtime.ps1 -Backend openvino"
      : "run scripts/fetch-runtime.ps1";
  checks.push({
    label: "llama-server",
    ok: binaryExists,
    detail: binaryExists
      ? `${config.server.binary}${version ? `\n    ${version.split(/\r?\n/)[0] ?? ""}` : ""}`
      : `not found at ${config.server.binary} -- ${fetchHint}`,
  });

  checks.push(
    ...(config.runtime.backend === "openvino" ? await openvinoChecks(config) : await cudaChecks(config)),
  );

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
