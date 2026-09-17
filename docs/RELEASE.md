# CI/CD and releases

## Workflows

| File | Role |
|---|---|
| `.github/workflows/build.yml` | Reusable: check, build the executable, package |
| `.github/workflows/ci.yml` | Calls `build.yml` on pushes and pull requests |
| `.github/workflows/openvino-runtime.yml` | Builds llama.cpp with the OpenVINO backend |
| `.github/workflows/release.yml` | Tags and publishes a GitHub Release |

### build.yml (reusable)

Three jobs in sequence.

1. **test** (ubuntu) — `bun install --frozen-lockfile`, typecheck with TypeScript 7, run the
   suite. Exports the version from `package.json` for the later jobs.
2. **exe** (windows) — `bun run build:win:native` produces the single-file executable.
   Building on Windows is what allows `--windows-hide-console`, so an MCP client launching
   it over stdio does not flash a console window. The suite then runs **against that
   executable** via `GEMMA_MCP_BIN`, and the reported version is compared with
   `package.json`.
3. **package** (ubuntu) — downloads the executable and runs `scripts/build.ts --package-only`,
   the same script developers use, producing the portable archive, the NSIS installer and
   `SHA256SUMS.txt`.

Step 2's smoke test matters: compiling bundles everything into one module graph and changes
evaluation order, which can break code that works perfectly from source. Only running the
artifact catches it.

The Bun version is pinned once, by `packageManager` in `mcp-server/package.json`; the
workflows read it through `bun-version-file`.

### openvino-runtime.yml

Upstream ships no prebuilt Windows binaries for the OpenVINO backend, so it is compiled
here: check out llama.cpp at the pinned tag, download the pinned OpenVINO toolkit, install
OpenCL through vcpkg, then configure with `-DGGML_OPENVINO=ON` and build. Both the toolkit
and the vcpkg tree are cached.

`scripts/ci/package-openvino.ts` then collects the binaries, the OpenVINO runtime DLLs and
device plugins, TBB and the upstream licences into
`llama-openvino-<llamacpp-tag>-win-x64.zip`, along with a `runtime-version.json` recording
what it was built from.

Versions are pinned in `openvino/build-config.json`. The build takes tens of minutes, so it
is not part of the ordinary CI run; the release workflow calls it, and it can also be
triggered by hand.

The runtime cannot be exercised on a GitHub runner — there is no Intel GPU or NPU there —
so the job only confirms the binary starts. Everything past that needs real hardware.

### release.yml

Three entry paths:

| Path | Behaviour |
|---|---|
| Push to `main` | If `package.json`'s version has no tag, create it and release |
| Push of a `v*` tag | Release that tag; a mismatch with `package.json` fails the run |
| Manual run | Release the given version |

An existing tag always means "do nothing", so a release never happens twice. That decision
lives in `scripts/ci/release-plan.ts` rather than in YAML.

A version containing a hyphen (`0.2.0-rc.1`) is published as a pre-release.

`scripts/ci/publish-release.ts` creates the tag, assembles the notes and publishes. The
fixed part of the notes is `.github/release-notes-template.md` (downloads table, setup
steps, checksums); GitHub's generated commit list is appended.

Assets attached to the release:

- `portable-gemma-setup-<version>.exe`
- `portable-gemma-win-x64-<version>.zip`
- `gemma-mcp.exe`
- `llama-openvino-<llamacpp-tag>-win-x64.zip` (when the OpenVINO build succeeded)
- `SHA256SUMS.txt`

The OpenVINO job is allowed to fail without holding back the release: `publish` only
requires `build`, and the notes state whether the OpenVINO asset made it in.

To preview the notes and the asset list without publishing anything:

```bash
DRY_RUN=1 TAG=v0.2.0 VERSION=0.2.0 GITHUB_REPOSITORY=<owner>/<repo> \
  bun run scripts/ci/publish-release.ts
```

## Cutting a release

```bash
bun run scripts/release.ts 0.2.0
```

That bumps the version, runs the typecheck and tests, and commits. Then:

```bash
git push origin main          # from main, tagging and publishing are automatic
```

Going through a pull request works the same way: merging a version bump into `main`
triggers the release. To be explicit instead:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`bun run scripts/release.ts 0.2.0 --push` commits and pushes in one go.

## Building locally

```bash
bun run scripts/build.ts
```

Produces the same artifacts on Linux: `bun build --compile --target=bun-windows-x64` for the
executable and `makensis` for the installer.

The only difference from CI is `--windows-hide-console`, which can only be passed on
Windows. It does not affect behaviour under test, but ship the CI-built executable.

Useful flags:

| Flag | Effect |
|---|---|
| `--package-only` | Skip checks and compilation; package an existing `dist/gemma-mcp.exe` |
| `--skip-tests` | Compile without the typecheck and test steps |
| `--native` | Use the Windows-only build; only works when running on Windows |

## Linting

The `lint` job runs actionlint, which also runs ShellCheck over the `run:` blocks. Locally:

```bash
actionlint
```
