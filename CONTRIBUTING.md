# Contributing to dsh-cloud-sandbox

Thank you for contributing to `dsh-cloud-sandbox`. This project provides a hardened Linux Docker execution runtime for DeepSeek Harness (`@deepseek-ai/dsh`).

## Prerequisites

- Node.js `>=22.19.0` (Node 24 recommended)
- `pnpm` (`>=10`)
- For live container integration testing: Linux host with Docker Engine accessible at `/var/run/docker.sock`

## Local Setup

```bash
pnpm install
pnpm run check
```

`pnpm run check` runs TypeScript type-checking (`typecheck`), the full Vitest suite (`test`), and ESM/declaration compilation (`build`).

## Development Guidelines

1. **Read [AGENTS.md](./AGENTS.md) first.** It documents the architectural invariants (user-agnostic workspace design, fail-closed security defaults, fair scheduling guarantees, and DSH capability seams).
2. **Test behavior at seams.** Unit and contract tests run without a live Docker daemon by injecting a fake `DockerClient`. Any change to path validation, mount policy, concurrency queuing, or stream demuxing must include deterministic tests.
3. **Preserve DSH compatibility.** Keep `@deepseek-ai/*` packages in `peerDependencies` with semver ranges covering `>=0.2.1-rc.2 <1.0.0`.
4. **Update documentation.** Add notable changes under `## [Unreleased]` in [CHANGELOG.md](./CHANGELOG.md).

## Pull Request Checklist

- [ ] `pnpm run check` passes cleanly with zero TypeScript errors or test failures
- [ ] Security invariants in [SECURITY.md](./SECURITY.md) are preserved
- [ ] No user-account or host-specific assumptions leak into the module
- [ ] `CHANGELOG.md` updated if public APIs, defaults, or behaviors changed
