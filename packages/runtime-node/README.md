# @kunlun-js/runtime-node

The Node.js reference runtime for Kunlun Engine. It translates Node HTTP streams to the Web Fetch
API used by `RuntimeApplication` and streams Fetch responses back to Node clients.

> Status: v0.1 source preview on the repository default branch. Check npm before assuming this
> package has been published. This adapter is a compatibility reference, not a hostile-code
> sandbox.

```ts
import { createRuntimeApplication, defineApplication, defineService, route } from '@kunlun-js/core'
import { nodeRuntime } from '@kunlun-js/runtime-node'

const application = createRuntimeApplication(defineApplication({
  name: 'hello',
  services: [
    defineService({
      name: 'hello-api',
      routes: [route('GET', '/hello', () => new Response('hello'))],
    }),
  ],
}))

const runtime = nodeRuntime({
  host: '127.0.0.1',
  shutdownGracePeriodMs: 5_000,
})
const server = await runtime.start(application, { port: 3000 })

console.log(server.url)
await server.close()
```

Constructor defaults are merged with options passed to `start()`, with start options taking
precedence. Built-in defaults are host `127.0.0.1`, port `3000`, production mode, and a five-second
shutdown grace period. Port `0` binds an operating-system-selected port.

When CORS is enabled, the adapter responds to preflight requests, adds the documented allow-origin,
method, and header fields, and otherwise delegates to the application. Handler failures call
`onError` when provided and produce a stable JSON 500 response if headers have not been sent.

`close()` stops accepting requests, closes idle connections, and force-closes remaining
connections after the grace period. It is safe to call more than once. Passing an `AbortSignal`
connects signal abortion to the same close path.

This package is part of [Kunlun Engine](https://github.com/kunlunengine/core), a project of Zixiao
Laboratories.
