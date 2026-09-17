#!/usr/bin/env bun
/**
 * Decide whether to release, and under which tag.
 *
 * Runs inside the release workflow and writes its decision to GITHUB_OUTPUT:
 *   version, tag, previous_tag, prerelease, needs_tag, should_release
 *
 * Three entry paths lead here:
 *   - a push to main: release when package.json's version has no tag yet
 *   - a v* tag push: release that tag, refusing a mismatch with package.json
 *   - a manual run: release the given version, defaulting to package.json
 *
 * An existing tag always means "do nothing", which is what stops double releases.
 */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..", "..");
const outputPath = process.env.GITHUB_OUTPUT;

async function emit(values: Record<string, string>): Promise<void> {
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  console.log(lines);
  if (outputPath) await appendFile(outputPath, `${lines}\n`);
}

async function tagExists(tag: string): Promise<boolean> {
  const result = await $`git rev-parse -q --verify refs/tags/${tag}`.cwd(root).nothrow().quiet();
  return result.exitCode === 0;
}

const pkg = (await Bun.file(join(root, "mcp-server", "package.json")).json()) as { version: string };
const refType = process.env.GITHUB_REF_TYPE ?? "";
const refName = process.env.GITHUB_REF_NAME ?? "";
const requested = process.env.INPUT_VERSION ?? "";

let version: string;
let needsTag: boolean;

if (refType === "tag") {
  version = refName.replace(/^v/, "");
  if (version !== pkg.version) {
    console.error(`::error::Tag ${refName} does not match package.json version ${pkg.version}`);
    process.exit(1);
  }
  needsTag = false;
} else {
  version = requested !== "" ? requested : pkg.version;
  needsTag = true;
}

const tag = `v${version}`;

if (await tagExists(tag)) {
  if (refType === "tag") {
    // On the tag path the tag is expected to exist already.
    needsTag = false;
  } else {
    console.log(`::notice::${tag} already exists; nothing to release`);
    await emit({ should_release: "false" });
    process.exit(0);
  }
}

const tags = await $`git tag --list v* --sort=-version:refname`.cwd(root).nothrow().text();
const previousTag = tags
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && line !== tag)[0] ?? "";

await emit({
  version,
  tag,
  previous_tag: previousTag,
  // A hyphen marks a pre-release: 0.2.0-rc.1 and friends.
  prerelease: version.includes("-") ? "true" : "false",
  needs_tag: needsTag ? "true" : "false",
  should_release: "true",
});
