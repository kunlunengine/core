# Changelog

## 0.2.0 - Unreleased

- Started the Kunlun Next.js design track for filesystem routing, server-first applications, and
  explicit server/client and capability boundaries.
- Added the first executable `@kunlun-js/next` contract: deterministic `app/` route discovery,
  nested layout inheritance, dynamic-segment validation, conflict diagnostics, and Fetch route
  handler module validation.
- Added `@kunlun-js/runtime-api` and the Node.js reference runtime at v0.1.0.
- Connected runtime startup and graceful shutdown to `kunlun dev` and `kunlun start`.
- Kept pnpm as the dependency manager while narrowing the CLI to a project shim and orchestrator.
- Added npm Trusted Publishing automation with GitHub Actions OIDC.
- Split the v0.3 workflow milestone into ordered capability slices and started Context7 submission
  preparation with a curated documentation index, parser policy, and expanded public references.

## 0.1.0 - 2026-08-20

- Introduced explicit application, service, route, and capability definitions.
- Added the bundler-neutral Build Engine protocol.
- Added first-party Nasti, Vite, Webpack, and Rspack adapters.
- Added the `kunlun` project, development, build, diagnostics, and engine CLI.
- Added real-build contract tests across all four engines.
