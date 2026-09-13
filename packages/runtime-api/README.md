# @kunlun-js/runtime-api

Runtime-neutral contracts for Fetch-compatible applications, server lifecycle, and explicit
capability bindings.

> Status: v0.1 source preview on the repository default branch. Check npm before assuming this
> package has been published.

## Capabilities

```ts
import { CapabilityRegistry } from '@kunlun-js/runtime-api'

const database = { query: (sql: string) => sql }
const capabilities = new CapabilityRegistry()
  .bind('database.orders', database)

capabilities.has('database.orders')
capabilities.get('database.orders')
capabilities.require('database.orders')
capabilities.snapshot()
capabilities.delete('database.orders')
```

`require()` throws `MissingRuntimeCapabilityError` if the binding is absent. `snapshot()` returns a
frozen record suitable for passing across the Core request-handler boundary. A registry is an
explicit binding mechanism; it is not by itself a security sandbox.

## Runtime adapter contract

```ts
import type { RuntimeAdapter, RuntimeApplication } from '@kunlun-js/runtime-api'

declare const runtime: RuntimeAdapter
declare const application: RuntimeApplication

const server = await runtime.start(application, {
  host: '127.0.0.1',
  port: 3000,
  mode: 'development',
  cors: true,
  shutdownGracePeriodMs: 5_000,
  onError(error, request) {
    console.error(request?.url, error)
  },
})

console.log(server.url)
await server.close()
```

A `RuntimeApplication` contains a serializable application manifest and
`fetch(request): Promise<Response>`. A `RuntimeAdapter` starts that application and returns a
server with its adapter name, bound address, public URL, in-process Fetch function, and idempotent
`close()` lifecycle.

`cors` accepts `true` for `*`, one origin string, or an array of origins. An `AbortSignal` can ask
the adapter to shut down. Exact transport behavior remains the adapter's responsibility.

This package is part of [Kunlun Engine](https://github.com/kunlunengine/core), a project of Zixiao
Laboratories.
