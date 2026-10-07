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
- Migrated repository tests from Vitest to Lightning 3, raising the contributor Node.js minimum
  to 22.12 while keeping existing public runtime packages at 20.19.
- Added `@kunlun-js/test-utils` for in-memory Core application tests, real HTTP tests, explicit
  capability doubles, and suite-scoped Lightning setup and teardown.
- Started the v0.3 CLI creation foundation: versioned first-party scaffold plans, no-write
  `create/new --dry-run --json`, stable creation diagnostics, and collision-safe execution of the
  same plan. This does not complete the full-stack v0.2 entry gate.

## 0.1.0 - 2026-08-20

- Introduced explicit application, service, route, and capability definitions.
- Added the bundler-neutral Build Engine protocol.
- Added first-party Nasti, Vite, Webpack, and Rspack adapters.
- Added the `kunlun` project, development, build, diagnostics, and engine CLI.
- Added real-build contract tests across all four engines.
