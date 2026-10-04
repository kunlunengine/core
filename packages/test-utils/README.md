# @kunlun-js/test-utils

Application and HTTP testing helpers for Kunlun Engine, inspired by the separation of runtime
and end-to-end testing in [Nuxt test-utils](https://nuxt.com/docs/4.x/getting-started/testing).

**Status: executable v0.2 source preview, not yet a published-package availability promise.**
This first slice tests explicit Core applications. It does not load `kunlun.config`, discover or
build filesystem applications, mount React components, initialize hydration, or launch browsers.

Requires Node.js >=22.12.0. The package root and `/runtime` are test-runner-neutral; `/e2e`
integrates with Lightning 3 and requires the optional `@lightning-js/lightning` peer dependency.
When working in this repository, run `pnpm install` and `pnpm build` before consuming package
exports. After publication, applications can install the utilities and runner as dev dependencies.

## In-memory application tests

`createTestApplication` validates an `ApplicationDefinition` and uses Core's real request handler
without starting a listener or modifying global state. Pass capability test doubles explicitly:

```ts
import { describe, expect, it } from '@lightning-js/lightning'
import { capability, defineApplication, defineService, route } from '@kunlun-js/core'
import { createTestApplication } from '@kunlun-js/test-utils/runtime'

const application = defineApplication({
  name: 'orders-app',
  services: [
    defineService({
      name: 'orders',
      capabilities: [capability('database.orders')],
      routes: [
        route('GET', '/orders/:id', ({ params, capabilities }) => {
          const database = capabilities['database.orders'] as { find(id: string): unknown }
          return Response.json(database.find(params.id!))
        }),
      ],
    }),
  ],
})

describe('orders', () => {
  it('serves an order using an explicit test capability', async () => {
    const context = createTestApplication(application, {
      capabilities: {
        'database.orders': { find: (id: string) => ({ id, status: 'ready' }) },
      },
    })
    await expect(context.$fetch('/orders/42')).resolves.toEqual({ id: '42', status: 'ready' })
    expect((await context.fetch('/missing')).status).toBe(404)
  })
})
```

Options:

- `capabilities`: Core's capability record or `CapabilityProvider`; required capabilities are
  checked before the helper returns.
- `baseURL`: HTTP(S) URL used to resolve relative requests; defaults to `http://kunlun.test/`.

The returned handle exposes `application` (the runtime application and its manifest), `url`,
`fetch`, and `$fetch`. No teardown is needed: the helper owns no server, timer, or global context.
Application-owned resources such as a database connection still need their own cleanup.
Handler exceptions propagate directly; use HTTP tests to assert the runtime's 500 responses.

## HTTP tests with Lightning

Call `setup` synchronously inside a `describe` block. It registers `beforeAll` and `afterAll`
hooks and returns a handle belonging to that suite, rather than a module-global current app:

```ts
import { describe, expect, it } from '@lightning-js/lightning'
import { setup } from '@kunlun-js/test-utils/e2e'
import { application } from './application.js'

describe('orders over HTTP', () => {
  const context = setup({
    application,
    capabilities: {
      'database.orders': { find: (id: string) => ({ id, status: 'ready' }) },
    },
    runtimeOptions: { cors: true },
  })

  it('serves the application through the HTTP adapter', async () => {
    const response = await context.fetch('/orders/42')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    await expect(response.json()).resolves.toEqual({ id: '42', status: 'ready' })
  })
})
```

Use the handle only after startup, inside tests or hooks registered after `setup`. Nested suites
can have separate handles without replacing the parent application. The server is closed even
when a test fails.

Setup options:

| Option | Default | Meaning |
| --- | --- | --- |
| `application` | required | Explicit Core `ApplicationDefinition` |
| `capabilities` | none | Capability record or provider passed to Core |
| `runtime` | `nodeRuntime()` | HTTP-capable `RuntimeAdapter` |
| `runtimeOptions` | loopback host, ephemeral port | `RuntimeStartOptions` except `mode`; tests always use `mode: 'test'` |
| `setupTimeout` | `30_000` | Maximum startup wait, in milliseconds |
| `teardownTimeout` | `30_000` | Maximum teardown wait, in milliseconds |

Setup owns an abort signal, combined with any caller-provided runtime signal. On startup failure,
startup timeout, or teardown completion/timeout it aborts that signal, so adapters can also clean
up partially initialized resources. If startup eventually returns after a timeout, the returned
server is closed instead of being exposed to tests. Timeouts report errors, not successful
cleanup: custom adapters must honor the signal and clean up their resources when startup rejects.

Unlike Nuxt's helpers, this API does not accept `rootDir`, `build`, or `browser`: those depend
on framework capabilities outside this package's current contract.

## Manual lifecycle with any runner

The root export does not import Lightning. `createTestServer` accepts the same application,
capabilities, runtime, and runtime options as `setup`, but leaves lifecycle ownership explicit:

```ts
import { createTestServer } from '@kunlun-js/test-utils'
import { application } from './application.js'

const context = await createTestServer({ application })
try {
  const response = await context.fetch('/health')
  console.log(response.status)
} finally {
  await context.close()
}
```

The handle also exposes the underlying `server`. `close()` is idempotent: repeated calls share
the same promise, including teardown errors. Requests through the handle reject after closing.
Requests use real HTTP, not the `RuntimeServer.fetch` in-memory shortcut.

## Shared request helpers

- `url(path = '')`: resolves with standard `new URL(path, baseURL)` semantics. For the HTTP
  server the base URL includes its assigned port.
- `fetch(input, init?)`: accepts a relative path, absolute URL, `URL`, or `Request`; forwards
  standard `RequestInit` and returns the raw `Response`, including non-2xx responses.
- `$fetch<T = unknown>(input, init?)`: parses JSON (`application/json` or `+json` media types),
  returns text otherwise, and returns `undefined` for an empty body. Non-2xx responses throw
  `TestFetchError`, whose `response` retains the readable body and whose `data` is the decoded
  payload (or the raw text if an error's JSON is malformed). Invalid JSON in a successful
  response rejects with the parsing error. This is not an `ofetch` compatibility API: no retries,
  implicit JSON request bodies, cookie jar, or runtime validation of `T` are provided.

In-memory requests always dispatch to the test application, even when the input has another
origin. HTTP requests and redirects use native Fetch and can reach external URLs. These helpers
are not a network isolation boundary.

## Runner configuration

Consumers can use ordinary Lightning configuration; no framework environment is required:

```ts
// lightning.config.ts
import { defineConfig } from '@lightning-js/lightning/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
})
```

Run `pnpm exec lightning run`, or `pnpm exec lightning watch` during development.
