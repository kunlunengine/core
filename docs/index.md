# Kunlun Engine documentation

This is the documentation entry point for the `kunlunengine/core` repository and the
`@kunlun-js/*` packages it owns.

## Version scope

The default branch is a source preview of the unreleased v0.2 development line. It declares
`0.2.0` for `@kunlun-js/core`, `@kunlun-js/cli`, and `@kunlun-js/next`, while several packages on
npm still have only a `0.1.0` release and the first Next.js-style and runtime packages may not yet
be published. Use the repository setup below when evaluating default-branch APIs. Do not infer
that a roadmap item or an unreleased package is available from npm.

## Choose the right layer

| Need | Start with | Status |
| --- | --- | --- |
| Explicit services, routes, capabilities, and config | [`@kunlun-js/core`](../packages/core/README.md) | executable |
| Build and development adapter contracts | [`@kunlun-js/build-api`](../packages/build-api/README.md) | executable |
| Nasti, Vite, Webpack, or Rspack integration | the matching [`builder-*`](../packages/builder-nasti/README.md) package | executable, capability-dependent |
| Runtime-neutral applications and capability registry | [`@kunlun-js/runtime-api`](../packages/runtime-api/README.md) | source preview |
| Node.js Fetch runtime | [`@kunlun-js/runtime-node`](../packages/runtime-node/README.md) | source preview |
| Filesystem route and layout discovery | [`@kunlun-js/next`](../packages/next/README.md) | v0.2 source preview |
| Project creation, build, development, and diagnostics | [`@kunlun-js/cli`](../packages/cli/README.md) | executable source preview |

Kunlun Next.js is a convention layer over the explicit core contracts. “Next.js-style” is a
description of its direction, not an API, plugin, rendering, or deployment compatibility promise.

## Start here

- [Repository overview and source-preview setup](../README.md)
- [Architecture and package boundaries](./architecture.md)
- [Core application API](../packages/core/README.md)
- [Filesystem route discovery contract](../packages/next/README.md)
- [CLI command reference](../packages/cli/README.md)
- [Runtime API](../packages/runtime-api/README.md) and
  [Node.js adapter](../packages/runtime-node/README.md)
- [Build API](../packages/build-api/README.md) and the engine capability matrix in the
  [repository overview](../README.md#engine-support)

For maintainers, the repository also contains the [release process](./releasing.md), the
[repository roadmap](../ROADMAP.md), and the detailed [v0.3 delivery slices](./plans/v0.3-slices.md).
Roadmap and planning documents describe future gates and are not API reference.

## Evaluate the source preview

Requirements: Node.js 20.19 or newer and pnpm 11.

```bash
git clone https://github.com/kunlunengine/core.git
cd core
corepack pnpm install
corepack pnpm check
corepack pnpm test
corepack pnpm build
node packages/cli/dist/cli.js --version
```

The public API is exported from package roots such as `@kunlun-js/core`. Imports from `src/` or
`dist/` are implementation details and are not supported application code.

## Current contract boundary

Implemented contracts include explicit application definitions, Fetch route handlers, capability
requirements, serializable application manifests, a build-engine protocol, four first-party build
adapters, a runtime protocol, the Node.js reference runtime, CLI orchestration, and deterministic
discovery of `layout`, `page`, and `route` modules.

The v0.2 source preview does not yet promise full-stack rendering, hydration, complete CLI
orchestration for filesystem applications, broad React Server Components behavior, or drop-in
Next.js compatibility. The package status note nearest an example is authoritative when a feature
is still provisional.
