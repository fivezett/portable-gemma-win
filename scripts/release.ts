#!/usr/bin/env bun
/**
 * Bump the version and kick off a release.
 *
 *   bun run scripts/release.ts 0.2.0            bump, verify and commit
 *   bun run scripts/release.ts 0.2.0 --push     also push, which triggers the release
 *
 * Pushing to main makes the release workflow notice that the version in package.json has
 * no tag yet; it then creates the tag and publishes the GitHub Release.
 */
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..");
const packagePath = join(root, "mcp-server", "package.json");

const [version, ...rest] = process.argv.slice(2);
const push = rest.includes("--push");

if (!version) {
  console.error("Usage: bun run scripts/release.ts <version> [--push]");
  console.error("  e.g. bun run scripts/release.ts 0.2.0");
  process.exit(2);
}

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Malformed version: ${version} (expected 0.2.0 or 0.2.0-rc.1)`);
  process.exit(2);
}

const pkg = (await Bun.file(packagePath).json()) as { version: string };
if (pkg.version === version) {
  console.error(`Already at ${version}.`);
  process.exit(2);
}

const status = await $`git status --porcelain`.cwd(root).text();
if (status.trim() !== "") {
  console.error("The working tree has uncommitted changes; clean it up first.");
  process.exit(2);
}

const tagExists = await $`git rev-parse -q --verify refs/tags/v${version}`.cwd(root).nothrow().quiet();
if (tagExists.exitCode === 0) {
  console.error(`Tag v${version} already exists.`);
  process.exit(2);
}

const branch = (await $`git rev-parse --abbrev-ref HEAD`.cwd(root).text()).trim();

console.log(`==> ${pkg.version} -> ${version}`);
pkg.version = version;
await Bun.write(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log("==> Verifying");
await $`bun install --frozen-lockfile`.cwd(join(root, "mcp-server")).quiet();
await $`bun run check`.cwd(join(root, "mcp-server"));
await $`bun test`.cwd(join(root, "mcp-server"));

await $`git add ${packagePath}`.cwd(root);
await $`git commit -m ${`chore: v${version}`}`.cwd(root);

console.log(`\nCommitted v${version} on branch ${branch}.`);

if (push) {
  if (branch !== "main") {
    console.warn("Releases only trigger from main; merge the pull request to publish.");
  }
  console.log("==> Pushing");
  await $`git push origin ${branch}`.cwd(root);
  console.log(`\nThe release workflow will tag v${version} and publish the GitHub Release.`);
} else {
  console.log("\nTo publish, either:");
  console.log(`  git push origin ${branch}                          # from main, tags and releases automatically`);
  console.log(`  git tag v${version} && git push origin v${version}  # release explicitly from a tag`);
}
