#!/usr/bin/env bun
/**
 * Assemble the OpenVINO runtime archive from a finished llama.cpp build.
 *
 * Collects, into one flat folder that mirrors how the CUDA releases are laid out:
 *   - llama.cpp binaries built with -DGGML_OPENVINO=ON
 *   - the OpenVINO runtime DLLs, their plugins.xml, and TBB
 *   - upstream licences, since this archive redistributes both projects
 *   - runtime-version.json, recording what it was built from
 *
 * Paths are discovered rather than hard-coded: the MSVC generator puts binaries under
 * bin/Release, Ninja puts them under bin, and the OpenVINO archive expands into a
 * version-named directory.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..", "..");
const staging = join(root, "build", "openvino-staging");
const dist = join(root, "dist");

type BuildConfig = {
  llamacpp_tag: string;
  openvino_version_major: string;
  openvino_version_full: string;
};

const config = (await Bun.file(join(root, "openvino", "build-config.json")).json()) as BuildConfig;

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

/** First match for a glob, searched from `cwd`. */
async function findOne(cwd: string, pattern: string): Promise<string | null> {
  if (!existsSync(cwd)) return null;
  for await (const match of new Bun.Glob(pattern).scan({ cwd, absolute: true, onlyFiles: false })) {
    return match;
  }
  return null;
}

async function copyGlob(cwd: string, pattern: string, label: string): Promise<number> {
  if (!existsSync(cwd)) {
    console.log(`    ${label}: ${cwd} does not exist, skipping`);
    return 0;
  }
  let count = 0;
  for await (const match of new Bun.Glob(pattern).scan({ cwd, absolute: true })) {
    await copyFile(match, join(staging, basename(match)));
    count += 1;
  }
  console.log(`    ${label}: ${count} file(s)`);
  return count;
}

console.log("==> Locating the build output");

// llama-server.exe is the anchor; everything it needs sits beside it.
const serverExe = await findOne(join(root, "llama.cpp", "build"), "**/llama-server.exe");
if (!serverExe) fail("llama-server.exe not found under llama.cpp/build -- did the build step run?");
const binDir = dirname(serverExe);
console.log(`    binaries: ${binDir}`);

const openvinoRoot = await findOne(join(root, "openvino_toolkit"), "*");
if (!openvinoRoot) fail("The OpenVINO toolkit was not found under openvino_toolkit/");
console.log(`    OpenVINO: ${openvinoRoot}`);

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await mkdir(dist, { recursive: true });

console.log("==> Collecting files");
const binaries = await copyGlob(binDir, "*.{exe,dll}", "llama.cpp binaries");
if (binaries === 0) fail(`No binaries found in ${binDir}`);

const ovBin = join(openvinoRoot, "runtime", "bin", "intel64", "Release");
const ovDlls = await copyGlob(ovBin, "*.dll", "OpenVINO runtime");
if (ovDlls === 0) fail(`No OpenVINO DLLs found in ${ovBin}`);

// Without plugins.xml the runtime cannot resolve the CPU, GPU or NPU plugins.
const pluginsXml = join(ovBin, "plugins.xml");
if (!existsSync(pluginsXml)) fail(`plugins.xml not found in ${ovBin}`);
await copyFile(pluginsXml, join(staging, "plugins.xml"));
console.log("    plugins.xml: 1 file(s)");

await copyGlob(join(openvinoRoot, "runtime", "3rdparty", "tbb", "bin"), "*.dll", "TBB");

console.log("==> Collecting licences");
const licences: [string, string][] = [
  [join(root, "llama.cpp", "LICENSE"), "LICENSE-llama.cpp.txt"],
  [join(openvinoRoot, "LICENSE"), "LICENSE-openvino.txt"],
  [join(openvinoRoot, "docs", "licensing", "third-party-programs.txt"), "openvino-third-party-programs.txt"],
];
for (const [source, name] of licences) {
  if (existsSync(source)) {
    await copyFile(source, join(staging, name));
    console.log(`    ${name}`);
  } else {
    console.log(`    ${name}: not present at ${source}, skipping`);
  }
}

await Bun.write(
  join(staging, "runtime-version.json"),
  `${JSON.stringify(
    {
      backend: "openvino",
      llamacpp_tag: config.llamacpp_tag,
      openvino_version: config.openvino_version_full,
      arch: "x64",
      built_at: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

const archive = join(dist, `llama-openvino-${config.llamacpp_tag}-win-x64.zip`);
await rm(archive, { force: true });

console.log("==> Creating the archive");
if (process.platform === "win32") {
  await $`powershell -NoProfile -Command ${`Compress-Archive -Path '${staging}\\*' -DestinationPath '${archive}' -CompressionLevel Optimal`}`;
} else {
  await $`zip -qr ${archive} .`.cwd(staging);
}

const size = (await Bun.file(archive).stat()).size;
console.log(`\n${basename(archive)}  (${(size / 1024 ** 2).toFixed(1)} MB)`);
console.log(`  llama.cpp ${config.llamacpp_tag} / OpenVINO ${config.openvino_version_full}`);
console.log(`  ${(await readdir(staging)).length} files staged`);
