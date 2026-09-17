#!/usr/bin/env bun
/**
 * Build the distributable artifacts.
 *
 *   dist/gemma-mcp.exe                      single-file executable
 *   dist/portable-gemma-win-x64-<ver>.zip   portable folder, for a USB stick
 *   dist/portable-gemma-setup-<ver>.exe     NSIS installer (only when makensis is present)
 *
 * Flags:
 *   --package-only   skip checks and compilation; package an existing dist/gemma-mcp.exe
 *   --skip-tests     compile without running typecheck and tests
 *   --native         use the Windows-only build (hidden console); requires running on Windows
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import pkg from "../mcp-server/package.json" with { type: "json" };

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const staging = join(root, "build", "staging");
const version = pkg.version;

const flags = new Set(process.argv.slice(2));
const packageOnly = flags.has("--package-only");
const skipTests = flags.has("--skip-tests");
const native = flags.has("--native");

function step(message: string): void {
  console.log(`==> ${message}`);
}

async function hasCommand(command: string): Promise<boolean> {
  return (await $`which ${command}`.nothrow().quiet()).exitCode === 0;
}

async function compile(): Promise<void> {
  step("Installing dependencies");
  const frozen = await $`bun install --frozen-lockfile`.cwd(join(root, "mcp-server")).nothrow().quiet();
  if (frozen.exitCode !== 0) {
    await $`bun install`.cwd(join(root, "mcp-server"));
  }

  if (!skipTests) {
    step("Typechecking");
    await $`bun run check`.cwd(join(root, "mcp-server"));

    step("Running tests");
    await $`bun test`.cwd(join(root, "mcp-server"));
  }

  step("Compiling gemma-mcp.exe");
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  const script = native ? "build:win:native" : "build:win";
  await $`bun run ${script}`.cwd(join(root, "mcp-server"));

  if (!skipTests) await smokeTest();
}

/**
 * Run the whole suite against a compiled binary rather than the sources.
 *
 * `bun build --compile` bundles everything into one module graph and changes evaluation
 * order, which can break libraries that work fine when run from source. Only executing the
 * binary catches that. On Windows the shipped artifact is testable directly; elsewhere we
 * compile an extra host-native binary from the same entry point.
 */
async function smokeTest(): Promise<void> {
  step("Smoke-testing the compiled binary");

  let binary = join(dist, "gemma-mcp.exe");
  if (process.platform !== "win32") {
    binary = join(root, "build", "gemma-mcp-host");
    await mkdir(join(root, "build"), { recursive: true });
    await $`bun build --compile --outfile ${binary} src/index.ts`.cwd(join(root, "mcp-server")).quiet();
    console.log("    (host-native build; the Windows artifact cannot run here)");
  }

  await $`bun test`.cwd(join(root, "mcp-server")).env({ ...process.env, GEMMA_MCP_BIN: binary });
}

async function stage(): Promise<void> {
  step("Staging");
  await rm(join(root, "build"), { recursive: true, force: true });
  await mkdir(join(staging, "scripts"), { recursive: true });
  await mkdir(join(staging, "docs"), { recursive: true });
  await mkdir(join(staging, "config"), { recursive: true });

  await $`cp ${join(dist, "gemma-mcp.exe")} ${join(root, "README.md")} ${staging}/`;

  for (const name of ["fetch-runtime.ps1", "fetch-model.ps1", "start-llama-server.cmd"]) {
    await $`cp ${join(root, "scripts", name)} ${join(staging, "scripts")}/`;
  }
  // RELEASE.md targets contributors, not users of the distributed folder.
  for (const name of ["SETUP.md", "MCP.md", "OPENVINO.md", "SPEC.md"]) {
    await $`cp ${join(root, "docs", name)} ${join(staging, "docs")}/`;
  }
  await $`cp ${join(root, "config", "gemma.toml.example")} ${join(staging, "config")}/`;
}

async function archive(): Promise<void> {
  const zipPath = join(dist, `portable-gemma-win-x64-${version}.zip`);
  if (!(await hasCommand("zip"))) {
    console.log("    zip is not installed; skipping the portable archive");
    return;
  }
  step("Creating the portable archive");
  await $`zip -qr ${zipPath} .`.cwd(staging);
}

async function installer(): Promise<void> {
  if (!(await hasCommand("makensis"))) {
    console.log("    makensis is not installed; skipping the installer");
    return;
  }
  step("Building the installer");
  await $`makensis -V2 -DSTAGING=${staging} -DVERSION=${version} ${join(root, "installer", "portable-gemma.nsi")}`;
}

async function checksums(): Promise<void> {
  if (!(await hasCommand("sha256sum"))) return;
  step("Writing checksums");
  const names = (await readdir(dist)).filter((name) => name !== "SHA256SUMS.txt").sort();
  const sums = await $`sha256sum ${names}`.cwd(dist).text();
  await Bun.write(join(dist, "SHA256SUMS.txt"), sums);
  console.log(sums.trimEnd());
}

console.log(`==> portable-gemma-win ${version}`);

if (packageOnly) {
  if (!existsSync(join(dist, "gemma-mcp.exe"))) {
    console.error("dist/gemma-mcp.exe is missing; --package-only needs a prebuilt executable.");
    process.exit(1);
  }
} else {
  await compile();
}

await stage();
await archive();
await installer();
await checksums();

console.log("\nDone:");
for (const name of (await readdir(dist)).sort()) {
  const size = (await Bun.file(join(dist, name)).stat()).size;
  console.log(`  ${name}  (${(size / 1024 ** 2).toFixed(1)} MB)`);
}
