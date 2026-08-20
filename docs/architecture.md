# Architecture

Kunlun Engine keeps four concerns separate:

```text
Application definitions
        │
        ▼
@kunlun-js/core ───────► application manifest ───────► Kunlun Runtime (planned)
        │
        ▼
@kunlun-js/build-api
   ├── builder-nasti
   ├── builder-vite
   ├── builder-webpack
   └── builder-rspack
        │
        ▼
@kunlun-js/cli ────────► local development / CI / remote workspaces
```

## Core boundary

`@kunlun-js/core` owns application semantics: service identity, routes, declared capabilities,
request handling, targets, and runtime manifests. It does not import a bundler.

The first request handler targets standard Fetch API `Request` and `Response` objects so that the
same service definitions can be exercised on Node.js today and on Kunlun Runtime later.

## Build protocol

`@kunlun-js/build-api` normalizes the data the framework actually needs:

- build contexts and client/server/extension targets;
- emitted artifacts, entry files, diagnostics, and durations;
- development URLs and middleware;
- optional transforms, server module loading, invalidation, and shutdown.

It does not normalize native plugin APIs. Each adapter accepts native configuration and plugins,
which avoids a misleading Vite-to-Webpack translation layer.

Capabilities are reported at runtime. The CLI and future framework integrations can choose a
fallback or produce a clear error when an engine lacks an optional feature.

## Why Nasti is the default, not a dependency

Nasti is maintained by Zixiao Laboratories and is built on Rolldown and Oxc. It is the reference
engine and receives the deepest Kunlun integration first. Keeping it behind the same public
protocol gives it real usage in Kunlun projects while preserving an exit path for teams with Vite,
Webpack, or Rspack investments.

The contract test suite builds the same application with all four engines to keep that promise
executable.

## Runtime direction

The planned runtime separates the JavaScript engine from authority. Rust host operations will
require opaque capability handles scoped to an extension, tenant, request, operation, and resource.
Native add-ons, FFI, and subprocesses are denied to untrusted extensions. Process, container, or
microVM isolation remains necessary for hostile code.

The first runtime prototype must validate JavaScriptCore distribution, ESM loading, Promise/async
bridging, GC rooting, execution termination, source maps, and debugging before compatibility claims
are made.

## Remote development direction

Kunlun will consume `devcontainer.json`, Features, lifecycle hooks, and prebuild conventions rather
than introduce a competing container format. A workspace control plane will add provider-neutral
machine selection, cache policy, secret brokering, port gateways, and idle lifecycle management.
