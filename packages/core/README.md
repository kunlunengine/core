# @kunlun-js/core

Explicit applications, services, routes, capabilities, manifests, runtime applications, and
configuration for Kunlun Engine.

> Status: the repository default branch declares v0.2.0 as an unreleased source preview. Check npm
> before assuming that default-branch APIs are in the published package.

## Define an application

```ts
import {
  capability,
  createRequestHandler,
  defineApplication,
  defineService,
  route,
} from '@kunlun-js/core'

const application = defineApplication({
  name: 'orders',
  version: '1.0.0',
  services: [
    defineService({
      name: 'orders-api',
      basePath: '/api',
      capabilities: [
        capability('database.orders', { operations: ['select'] }),
      ],
      routes: [
        route('GET', '/orders/:id', ({ params, capabilities }) => {
          const database = capabilities['database.orders'] as {
            find(id: string): unknown
          }
          return Response.json(database.find(params.id))
        }),
      ],
    }),
  ],
})

const fetch = createRequestHandler(application, {
  capabilities: {
    'database.orders': { find: (id: string) => ({ id }) },
  },
})

const response = await fetch(new Request('http://local/api/orders/42'))
```

Route handlers receive the Web Fetch API `Request`, decoded path parameters, the explicit
capability record, and the owning service name. A matched path with the wrong method returns 405;
an unmatched path returns 404.

Required capabilities are checked when the request handler is created. A missing requirement
throws `MissingCapabilityError` before the application begins serving. Mark a requirement
`optional: true` only when the handler can operate without that binding.

## Configure a build and runtime

```ts
import { nasti } from '@kunlun-js/builder-nasti'
import { defineConfig } from '@kunlun-js/core'
import { nodeRuntime } from '@kunlun-js/runtime-node'

export default defineConfig({
  application,
  builder: nasti(),
  runtime: nodeRuntime(),
  runtimeOptions: { port: 3000 },
  capabilities: {
    'database.orders': { find: (id: string) => ({ id }) },
  },
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

When `targets` is omitted, `defineConfig()` supplies one client target with `index.html` as its
entry and `dist/client` as its output directory. Build engines and runtimes remain explicit objects
and can be replaced independently.

## Public API

| Export | Purpose |
| --- | --- |
| `capability(name, options?)` | Declare a named required or optional capability and its operations. |
| `route(method, path, handler)` | Normalize an HTTP method and path into a route definition. |
| `defineService(definition)` | Validate and freeze one service, its routes, and its capabilities. |
| `defineApplication(definition)` | Validate service identity and application-wide route uniqueness. |
| `defineConfig(config)` | Validate an application, builder, targets, runtime, and capability bindings. |
| `createApplicationManifest(application)` | Produce the serializable application view used by builders and runtimes. |
| `createRequestHandler(application, options?)` | Compile an application into a Fetch-compatible request function. |
| `createRuntimeApplication(application, options?)` | Pair the request function with its application manifest. |
| `CapabilityRegistry` | Bind, query, snapshot, and remove runtime capabilities explicitly. |
| `MissingCapabilityError` | Report a service requirement that has no runtime binding. |

Runtime types and `CapabilityRegistry` are re-exported from `@kunlun-js/runtime-api`; build engine,
manifest, and capability types are re-exported from `@kunlun-js/build-api` where noted by the
TypeScript declarations.

## Validation rules

- Application, service, capability, target, and route-parameter names begin with a letter and then
  use letters, numbers, `.`, `_`, or `-`.
- An application contains at least one service.
- Duplicate service names, duplicate capability names within a service, and duplicate method/path
  pairs are rejected.
- Paths are normalized to a leading slash and no trailing slash except `/`.
- Dynamic route parameters use `:name` in explicit Core routes.

This package is part of [Kunlun Engine](https://github.com/kunlunengine/core), a project of Zixiao
Laboratories. Use only package-root imports; `src/` and `dist/` paths are not public API.
