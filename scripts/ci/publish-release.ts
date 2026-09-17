#!/usr/bin/env bun
/**
 * Create the tag if needed, assemble the release notes and publish the GitHub Release.
 *
 * Reads from the environment: TAG, PREVIOUS_TAG, VERSION, NEEDS_TAG, PRERELEASE,
 * GITHUB_REPOSITORY and GH_TOKEN.
 *
 * The fixed part of the notes lives in .github/release-notes-template.md. Keeping it in a
 * file rather than inline in the workflow avoids the shell mangling backslashes and
 * backticks in the Windows code samples.
 */
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..", "..");
const dist = join(root, "dist");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`::error::${name} is not set`);
    process.exit(1);
  }
  return value;
}

const tag = required("TAG");
const version = required("VERSION");
const repository = required("GITHUB_REPOSITORY");
const previousTag = process.env.PREVIOUS_TAG ?? "";
const needsTag = process.env.NEEDS_TAG === "true";
const prerelease = process.env.PRERELEASE === "true";

if (needsTag) {
  console.log(`==> Creating ${tag}`);
  await $`git config user.name "github-actions[bot]"`.cwd(root);
  await $`git config user.email "41898282+github-actions[bot]@users.noreply.github.com"`.cwd(root);
  await $`git tag -a ${tag} -m ${tag}`.cwd(root);
  await $`git push origin ${tag}`.cwd(root);
}

console.log("==> Assembling release notes");

// Let GitHub produce the commit list.
const generated = previousTag
  ? await $`gh api repos/${repository}/releases/generate-notes -f tag_name=${tag} -f previous_tag_name=${previousTag} --jq .body`.text()
  : await $`gh api repos/${repository}/releases/generate-notes -f tag_name=${tag} --jq .body`.text();

const checksums = (await Bun.file(join(dist, "SHA256SUMS.txt")).text()).trimEnd();
const template = await Bun.file(join(root, ".github", "release-notes-template.md")).text();

const header = template
  .replaceAll("{{VERSION}}", version)
  .replaceAll("{{TAG}}", tag)
  .replaceAll("{{REPOSITORY}}", repository)
  .replaceAll("{{CHECKSUMS}}", checksums);

const notesPath = join(root, "release-notes.md");
await Bun.write(notesPath, `${header}\n${generated}`);
console.log(await Bun.file(notesPath).text());

console.log(`==> Publishing ${tag}`);
const assets = [
  ...(await Array.fromAsync(new Bun.Glob("portable-gemma-setup-*.exe").scan({ cwd: dist, absolute: true }))),
  ...(await Array.fromAsync(new Bun.Glob("portable-gemma-win-x64-*.zip").scan({ cwd: dist, absolute: true }))),
  join(dist, "gemma-mcp.exe"),
  join(dist, "SHA256SUMS.txt"),
];

const flags = prerelease ? ["--prerelease"] : [];
await $`gh release create ${tag} --title ${tag} --notes-file ${notesPath} ${flags} ${assets}`;

console.log(`::notice::Published ${tag}`);
