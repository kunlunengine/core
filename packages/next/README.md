# Kunlun Next.js

Kunlun Next.js is the first-party, Next.js-style full-stack framework for Kunlun Engine. It brings
a convention-driven application model to Kunlun while keeping the platform's capabilities, build
engines, and runtimes explicit.

> Status: v0.2 in progress. The first executable contract covers route discovery and route-handler
> validation. Rendering, build-target compilation, and CLI orchestration remain provisional.

"Next.js-style" describes the developer experience we are pursuing: filesystem routing, nested
layouts, server-first rendering, route handlers, and explicit server/client boundaries. It does
not mean API, plugin, rendering, or deployment compatibility with Next.js.

## Place in the stack

```text
app/ conventions
       │
       ▼
Kunlun Next.js ─────► explicit @kunlun-js/core definitions
                              │
                   ┌──────────┴──────────┐
                   ▼                     ▼
              BuildEngine          RuntimeAdapter
       Nasti / Vite / Webpack /   Node.js / native JSC
                  Rspack
```

Kunlun Next.js is a compiler and convention layer, not a second application core. Its discovered
routes, layouts, build targets, and capability requirements must compile into the same public
contracts used by hand-written Kunlun applications. Projects can drop below the conventions and
use `@kunlun-js/core` directly without changing build engines or runtimes.

## Design principles

- **Server-first, with an explicit client boundary.** Server-only modules must stay out of browser
  bundles. Interactive client subtrees cross a visible module boundary and accept serializable
  inputs.
- **Capabilities remain explicit.** Filesystem conventions must never grant ambient database,
  network, filesystem, secret, or subprocess authority. Server code declares what it needs, and
  the selected runtime decides what is granted.
- **Portable request handling.** Route handlers use standard Fetch API `Request` and `Response`
  objects so they can run on the Node.js reference runtime and, later, the native JSC runtime.
- **Bundler neutrality is preserved.** Nasti is the reference engine, while other adapters expose
  their real capabilities and limitations through `BuildEngine`.
- **Conventions compile to inspectable artifacts.** Route tables, server/client entries,
  capability requirements, and runtime metadata must be available to `kunlun doctor`, build tools,
  and deployment systems.
- **Escape hatches are public contracts.** Native build-engine configuration remains available;
  Kunlun Next.js will not hide it behind an incomplete compatibility layer.

## Provisional application shape

The v0.2 exploration starts with an `app/` tree familiar to developers of filesystem-routed
frameworks:

```text
app/
├── layout.tsx
├── page.tsx
├── orders/
│   └── [id]/
│       └── page.tsx
└── api/
    └── orders/
        └── route.ts
kunlun.config.mjs
```

The first executable contract fixes the `layout`, `page`, and `route` filenames and method-named
route-handler exports. Later conventions will be added only with compiler and server/client module
graph tests. We will prefer a small set of composable conventions over copying the full surface of
another framework.

## Route discovery contract

The first v0.2 implementation discovers `layout`, `page`, and `route` modules with JavaScript or
TypeScript source extensions. `discoverAppRoutes()` emits stable source paths relative to the
configured `app/` directory, core-compatible paths such as `/orders/:id`, ordered layout ancestry,
and structured diagnostics.

```ts
import { discoverAppRoutes } from '@kunlun-js/next'
import { fileURLToPath } from 'node:url'

const manifest = await discoverAppRoutes({
  appDir: fileURLToPath(new URL('./app', import.meta.url)),
})
```

Dynamic segments use `[name]`. Catch-all and optional forms are deliberately not part of the v0.2
contract. A `route.ts` module exports one or more Fetch handlers named `GET`, `HEAD`, `POST`, `PUT`,
`PATCH`, `DELETE`, or `OPTIONS`; `validateRouteHandlerModule()` validates that loaded-module
boundary without coupling discovery to a TypeScript loader or build engine.

## v0.2 first slice

The first implementation slice delivers discovery of pages, nested layouts, dynamic segments, and
Fetch route handlers, plus validation of loaded route-handler exports. Rendering, compilation into
`@kunlun-js/core` services and client/server build targets, server/client module boundaries, CLI
orchestration, runtime conformance, and complete runnable examples remain later, provisional work.

The native Rust + JavaScriptCore runtime is not a prerequisite for this slice. It advances in the
separate [`kunlunengine/runtime`](https://github.com/kunlunengine/runtime) repository and will join
the same runtime contract when its application-compatibility milestone is ready.

## Non-goals for v0.2

- Drop-in compatibility with Next.js applications or plugins.
- Reproducing every App Router convention before the core route and rendering contracts stabilize.
- Replacing pnpm, a build engine, or a runtime adapter.
- Treating a JavaScript realm or a capability declaration as a complete hostile-code sandbox.

The implementation will live under the `@kunlun-js` npm scope. The first reference renderer will
target React, while its public API remains provisional until the executable contracts above pass.
See the repository [v0.2-v0.4 roadmap](../../ROADMAP.md) for the release gate and later work.
If you would like to help shape and own this work, see
[maintainers wanted](../../docs/community/maintainers-wanted.md).
