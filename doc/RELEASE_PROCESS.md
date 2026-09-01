# Local release process

## Policy

CI is a fast, manifest-selected baseline. It does not qualify an npm release. A release is qualified only when the full local gate passes on Linux x64 under Node 22 and Bun 1.4.0, produces local evidence, and the exact qualified tarball is then passed to the guarded publish command.

The version published to npm is the `version` in `packages/web/package.json`. Other workspace package versions are recorded in qualification evidence for traceability, but they are private workspace identities and are not required to equal the publish version.

The tag-triggered GitHub workflow never publishes. It runs only the `ci` profile and does not upload qualification logs, evidence, screenshots, or tarballs.

## Supported qualification matrix

| Surface | Status | Qualification |
| --- | --- | --- |
| Linux x64 | Supported | Every required `full` scenario targets `linux-x64`. |
| Node 22 | Supported and required | Full qualification must execute under Node major 22, not merely a newer compatible runtime. |
| Bun 1.4.0 | Supported and required | Manifest parsing and preflight reject another Bun version. |
| Web server | Supported | HTTP/auth/SSE/filesystem/config contracts run over an isolated loopback server. Production startup still binds to `0.0.0.0` by default; tests inject `127.0.0.1`. |
| Stable UI contract groups | Supported | Reviewed sync pipeline, runtime fetch, route serialization, and authentication tests run in isolated Bun processes to avoid vendored global-mock interference. The unstable all-at-once vendored suite is not falsely reported as green. |
| Browser critical path | Supported | A repository-owned Playwright scenario loads the packed UI, creates a deterministic local session, sends a prompt through real HTTP, receives the response through the real SessionStore/SSE pipeline, verifies rendered text, reloads, and verifies restoration. |
| npm packed CLI | Supported | The exact tarball is installed with native dependency scripts enabled, started, health-checked, stopped, and restarted. |
| Single workspace | Supported | One configured workspace per server process. |
| Real provider/model network calls | Unsupported | Qualification does not consume provider credentials or perform billable model calls. |
| macOS, Windows, Linux arm64, Electron, mobile, multi-workspace | Unsupported | These surfaces are explicit exclusions, never reported as passed. |

`release-scenarios.json` is the only scenario inventory. Each supported capability must be referenced by at least one required `full` scenario. The gate rejects duplicate IDs, unknown profiles, malformed prerequisites, and supported capabilities with no required coverage.

## Prerequisites

1. Linux x64.
2. Node 22.x (`node --version`).
3. Bun 1.4.0 (`bun --version`).
4. npm, Git, a POSIX `sh`, `tar`, and a working native build/install environment for `node-pty`.
5. Playwright's Chromium browser installed locally: `bunx playwright install chromium`. The browser binary remains local and is not uploaded.
6. A clean Git worktree, including no untracked release-relevant files.
7. Installed workspace dependencies: `bun install --frozen-lockfile`.

Qualification child processes receive isolated temporary `HOME`, workspace, pi-agent state, install directories, and loopback ports. Environment variables whose names indicate tokens, passwords, secrets, credentials, authentication values, or API keys are removed by default. Known inherited secret values are also redacted from scenario logs. No repository-stored secret is required.

## Commands

Fast CI-equivalent baseline:

```bash
bun run release:scenarios -- --profile ci
```

Focused local profiles may be selected from the manifest (`backend`, `runtime`, `browser`, `artifact`, or `gate-self-test`), but they do not create qualification evidence.

Full local qualification:

```bash
bun run release:qualify
```

Preflight-only inspection, with no scenarios, build, pack, install, upload, or publication:

```bash
bun run release:qualify -- --dry-run
```

Validate an existing receipt without invoking npm or any network publication:

```bash
bun run release:publish -- --dry-run
```

Publish the exact qualified tarball:

```bash
bun run release:publish
```

Only the final non-dry-run publish command intentionally invokes `npm publish`. It preserves the release channel rule: prerelease versions use `next`; stable versions use `latest`. It never rebuilds the artifact.

## Evidence and artifact binding

A successful run writes:

```text
.release-evidence/<publish-version>/<git-head>/<timestamp>/
  qualification.json
  logs/<scenario-id>.log
  artifacts/<qualified-tarball>.tgz
```

`.release-evidence/` is ignored by Git. Evidence, logs, browser screenshots, and tarballs remain on the release machine. There is no qualification upload step, CI artifact upload, telemetry path, object-storage path, GitHub upload, or npm upload.

The receipt has schema version 1 and is valid for 24 hours. It records:

- publish version and all workspace package versions;
- Git HEAD and tree;
- clean-worktree result;
- manifest SHA-256;
- Node, Bun, npm, platform, and architecture;
- exact tarball path, size, SHA-256, and distribution-directory hash;
- every scenario status, duration, command fingerprint, exit code, and local log reference;
- local-only and redaction declarations.

Evidence is written using a temporary file, file `fsync`, atomic rename, and directory `fsync`. Missing, partial, unparseable, expired, unsupported-schema, or non-passing evidence is rejected.

## Publish validation

`release:publish` fails closed unless all of the following still match the receipt:

- clean worktree;
- Git HEAD and tree;
- publish version from `packages/web/package.json`;
- release manifest hash;
- distribution-directory hash;
- tarball path and SHA-256;
- evidence schema, timestamp, validity policy, and required scenario results.

The generated npm package includes a `prepublishOnly` lifecycle guard. Direct publication from `dist/` or publication without the validated evidence/artifact environment is rejected.

## Explicit unknown API behavior

Known routes return their documented contract. Any unknown `/api/*` operation returns HTTP 404 with:

```json
{
  "error": "unsupported endpoint",
  "method": "GET",
  "path": "/the/unknown/path"
}
```

Unknown operations are not converted into empty arrays, empty objects, idle streams, or other success-shaped responses. An unsupported capability therefore cannot be mistaken for passed qualification or authoritative empty state.

## Failure recovery

- **Dirty worktree:** review the changes and commit or remove them; do not bypass the clean-tree check.
- **Missing prerequisite:** install the required local tool or narrow the supported matrix in a reviewed manifest change. Required scenarios may not be skipped.
- **Scenario failure:** inspect its local log, fix the root cause, and rerun full qualification. Failed runs do not write a success receipt.
- **Interrupted/partial evidence:** discard the incomplete run directory and rerun; partial JSON is never accepted.
- **Stale evidence or changed source/manifest/artifact:** rerun full qualification. Do not edit the receipt.
- **Publish interruption:** if the artifact and unexpired receipt remain unchanged, rerun the publish validation. Otherwise qualify again.

Neither qualification nor any self-test deploys infrastructure, uploads evidence, or contacts `npm publish`. Release-gate tests intercept publication in-process rather than relying on a public registry or a dry-run claim alone.
