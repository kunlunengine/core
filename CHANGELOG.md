# Changelog

## 0.2.0 - Unreleased

- Added `@kunlun-js/runtime-api` and the Node.js reference runtime at v0.1.0.
- Connected runtime startup and graceful shutdown to `kunlun dev` and `kunlun start`.
- Kept pnpm as the dependency manager while narrowing the CLI to a project shim and orchestrator.
- Added npm Trusted Publishing automation with GitHub Actions OIDC.

## 0.1.0 - 2026-08-20

- Introduced explicit application, service, route, and capability definitions.
- Added the bundler-neutral Build Engine protocol.
- Added first-party Nasti, Vite, Webpack, and Rspack adapters.
- Added the `kunlun` project, development, build, diagnostics, and engine CLI.
- Added real-build contract tests across all four engines.
