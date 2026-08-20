<div align="center">
  <img src="./kunlun-logo.png" alt="Kunlun Engine" width="180">

# Kunlun Engine

**An explicit, capability-aware, bundler-neutral TypeScript application platform.**

[Architecture](./docs/architecture.md) · [Show HN draft](./docs/launch/show-hn.md) · [X launch post](./docs/launch/x-post.txt)
</div>

Kunlun Engine separates application semantics from JavaScript build tools. Applications define
services, routes, capability requirements, and build targets once, then choose Nasti, Vite,
Webpack, or Rspack through first-party adapters.

This repository is an early v0.1 source preview. The public packages use the registered
`@kunlun-js` scope; npm publication will follow the source preview.

## Why

Frameworks should not make a bundler an architectural dependency. We want teams to use a fast,
integrated default without making existing Vite, Webpack, or Rspack projects pay a migration tax.
Nasti is the recommended default and reference implementation, while every engine implements the
same public build contract and retains access to its native configuration.

The application core is similarly explicit: no decorators, reflection metadata, or hidden IoC
container. Required resources are declared as capabilities and compiled into a runtime-readable
manifest.

## What works in v0.1

- Explicit applications, services, routes, path parameters, and capability requirements.
- Portable Fetch API request handlers and serializable application manifests.
- A capability-negotiated `BuildEngine` protocol.
- Production builds with Nasti, Vite, Webpack, and Rspack.
- Development sessions and middleware for all four engines.
- Native module transforms, HMR, and SSR loading where the selected engine exposes them.
- `kunlun new`, `dev`, `build`, `doctor`, and `engines` commands.
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
- `@kunlun-js/builder-nasti` — recommended Nasti adapter.
- `@kunlun-js/builder-vite` — Vite adapter.
- `@kunlun-js/builder-webpack` — Webpack adapter.
- `@kunlun-js/builder-rspack` — Rspack adapter.
- `@kunlun-js/cli` — the `kunlun` command.

## Direction

The next layer is Kunlun Runtime: a Rust host embedding JavaScriptCore, designed for fast startup
and capability grants scoped more narrowly than process-wide permission flags. Untrusted
extensions will also require operating-system isolation; a JavaScript realm alone is not treated
as a security boundary.

Remote workspaces will consume the existing Development Container Specification and add a
provider-neutral control plane for prebuilds, caches, secrets, port routing, and workspace
lifecycle.

See [the architecture notes](./docs/architecture.md) for the package boundaries and compatibility
strategy.

## Project

Kunlun Engine is a project of **Zixiao Laboratories**. It is released under the
[MIT License](./LICENSE); the copyright attribution is recorded in that license.
