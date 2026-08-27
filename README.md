<div align="center">
  <img src="./kunlun-logo.png" alt="Kunlun Engine" width="180">

# Kunlun Engine

**An explicit, capability-aware, bundler-neutral TypeScript application platform.**

[Architecture](./docs/architecture.md) · [Roadmap](./ROADMAP.md) · [Maintainers wanted](./docs/community/maintainers-wanted.md)
</div>

Kunlun Engine separates application semantics from JavaScript build tools. Applications define
services, routes, capability requirements, and build targets once, then choose Nasti, Vite,
Webpack, or Rspack through first-party adapters.

The first packages are published under the registered `@kunlun-js` scope. The v0.2 development
line adds a first-party, convention-driven full-stack layer while retaining the runtime-neutral
protocol, Node.js reference runtime, and CLI orchestration established by v0.1.

## Why

Frameworks should not make a bundler an architectural dependency. We want teams to use a fast,
integrated default without making existing Vite, Webpack, or Rspack projects pay a migration tax.
Nasti is the recommended default and reference implementation, while every engine implements the
same public build contract and retains access to its native configuration.

The application core is similarly explicit: no decorators, reflection metadata, or hidden IoC
container. Required resources are declared as capabilities and compiled into a runtime-readable
manifest.

## What works

- Explicit applications, services, routes, path parameters, and capability requirements.
- Portable Fetch API request handlers and serializable application manifests.
- A runtime adapter protocol and explicit capability registry.
- A Node.js reference runtime that serves Fetch applications over HTTP.
- A capability-negotiated `BuildEngine` protocol.
- Production builds with Nasti, Vite, Webpack, and Rspack.
- Development sessions and middleware for all four engines.
- Native module transforms, HMR, and SSR loading where the selected engine exposes them.
- `kunlun new`, `dev`, `build`, `start`, `doctor`, and `engines` commands.
- Contract tests that execute real builds with all four engines.

## Engine support

| Capability | Nasti | Vite | Webpack | Rspack |
| --- | --- | --- | --- | --- |
| Production build | Yes | Yes | Yes | Yes |
| Dev middleware | Yes | Yes | Yes | Yes |
| HMR exposed by v0.1 adapter | Yes | Yes | Not yet | Not yet |
| Module transform API | Yes | Yes | Not yet | Not yet |
| SSR module runner | Yes | Yes | Not yet | Not yet |
| Multiple environments | Native | Native | Orchestrated | Orchestrated |

The matrix is intentionally explicit. Kunlun does not pretend that different bundlers have
identical plugin models or lifecycle semantics.

## Try the source preview

Requires Node.js 20.19 or newer and pnpm 11.

```bash
git clone https://github.com/kunlunengine/core.git
cd core
corepack pnpm install
corepack pnpm check
corepack pnpm test
corepack pnpm build
node packages/cli/dist/cli.js engines
```

Create a project with Nasti, the default engine:

```bash
node packages/cli/dist/cli.js new ../hello-kunlun
```

Or select another engine:

```bash
node packages/cli/dist/cli.js new ../hello-kunlun --builder vite
node packages/cli/dist/cli.js new ../hello-kunlun --builder webpack
node packages/cli/dist/cli.js new ../hello-kunlun --builder rspack
```

## Application and build configuration

```js
// kunlun.config.mjs
import { nasti } from '@kunlun-js/builder-nasti'
import {
  capability,
  defineApplication,
  defineConfig,
  defineService,
  route,
} from '@kunlun-js/core'

const application = defineApplication({
  name: 'orders',
  services: [
    defineService({
      name: 'orders-api',
      basePath: '/api',
      capabilities: [capability('database.orders', { operations: ['select'] })],
      routes: [
        route('GET', '/orders/:id', ({ params }) => Response.json({ id: params.id })),
      ],
    }),
  ],
})

export default defineConfig({
  application,
  builder: nasti(),
  targets: [
    {
      name: 'client',
      consumer: 'client',
      entries: { main: './src/main.js' },
      outDir: 'dist/client',
    },
  ],
})
```

Switching the build engine changes one import and one constructor. Native engine options remain
available inside that constructor.

## Packages

- `@kunlun-js/core` — application, service, route, capability, and config APIs.
- `@kunlun-js/build-api` — the stable build engine and dev session protocol.
- `@kunlun-js/runtime-api` — runtime-neutral server, lifecycle, and capability contracts.
- `@kunlun-js/runtime-node` — the Node.js reference runtime.
- `@kunlun-js/builder-nasti` — recommended Nasti adapter.
- `@kunlun-js/builder-vite` — Vite adapter.
- `@kunlun-js/builder-webpack` — Webpack adapter.
- `@kunlun-js/builder-rspack` — Rspack adapter.
- `@kunlun-js/cli` — the `kunlun` command.

## Roadmap

The repository-wide [v0.2-v0.4 roadmap](./ROADMAP.md) defines capability-based exit gates rather
than calendar promises. In short: v0.2 makes the full-stack application path runnable, v0.3 makes
the daily development workflow coherent, and v0.4 makes server artifacts portable across runtime
adapters.

We are also [looking for maintainers](./docs/community/maintainers-wanted.md) to own focused parts
of the application, build-engine, runtime-contract, CLI, quality, and community workstreams.

## Direction

The v0.2 application track starts with [Kunlun Next.js](./packages/next/README.md), a first-party
full-stack convention layer that compiles filesystem routes, server/client boundaries, and
capability requirements into the existing public core contracts. "Next.js-style" describes the
developer experience; it is not a compatibility promise.

The native Rust host embedding JavaScriptCore now advances independently in the
[`kunlunengine/runtime`](https://github.com/kunlunengine/runtime) repository. It has entered the M1
reproducible-distribution and safe-binding milestone. The Node.js adapter keeps the runtime
boundary executable while that work continues. Native capability grants are designed to be scoped
more narrowly than process-wide permission flags, and untrusted extensions will still require
operating-system isolation; a JavaScript realm alone is not treated as a security boundary.

pnpm remains responsible for dependency resolution, installation, workspace linking, and script
execution. `kunlun` is intentionally a thin project shim and orchestrator; it does not embed or
replace a package manager.

Remote workspaces will consume the existing Development Container Specification and add a
provider-neutral control plane for prebuilds, caches, secrets, port routing, and workspace
lifecycle.

See [the architecture notes](./docs/architecture.md) for the package boundaries and compatibility
strategy.

## Project

Kunlun Engine is a project of **Zixiao Laboratories**. It is released under the
[MIT License](./LICENSE); the copyright attribution is recorded in that license.
