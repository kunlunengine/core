# @kunlun-js/build-api

Bundler-neutral build and development-session protocol for Kunlun Engine. It describes the data
Kunlun needs without translating native plugin systems between Nasti, Vite, Webpack, and Rspack.

> Status: executable v0.1 contract. Optional behavior is selected from each engine's advertised
> capabilities, not assumed from the protocol.

## Lifecycle

```ts
import type { BuildEngine } from '@kunlun-js/build-api'

async function buildClient(engine: BuildEngine) {
  const session = await engine.createSession({
    root: process.cwd(),
    mode: 'production',
  })

  try {
    return await session.build({
      name: 'client',
      consumer: 'client',
      entries: { main: './src/main.js' },
      outDir: 'dist/client',
      sourcemap: true,
      minify: true,
    })
  } finally {
    await session.close()
  }
}
```

`createSession()` receives one root, mode, and optional serializable application manifest. A build
request names its target, consumer (`client`, `server`, or `extension`), entries, and output
directory. Results report normalized artifacts, entries, diagnostics, duration, and optional
engine-native output in `raw`.

Development uses `session.serve(request)`. The returned `DevSession` always has URLs and an
idempotent `close()` operation. Middleware, transforms, SSR module loading, and invalidation are
optional and must be gated by the engine's capabilities.

## Capability fields

| Field | Meaning |
| --- | --- |
| `hmr` | The adapter exposes hot-update behavior. |
| `middleware` | A development HTTP middleware is available. |
| `moduleGraph` | The adapter exposes a usable module graph. |
| `multiEnvironment` | `false`, `orchestrated`, or native multi-environment support. |
| `ssrModuleRunner` | The adapter can load server modules in development. |
| `lazyCompilation` | The adapter exposes lazy compilation through this integration. |

`BuildEngineError` carries the engine name and structured warning/error diagnostics. Consumers
should present those diagnostics before falling back to the error message.

First-party engines are created by `nasti()`, `vite()`, `webpack()`, and `rspack()` from their
matching `@kunlun-js/builder-*` packages. Native configuration stays inside the constructor's
`config` option.

This package is part of [Kunlun Engine](https://github.com/kunlunengine/core), a project of Zixiao
Laboratories.
