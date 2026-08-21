# @kunlun-js/runtime-api

Runtime-neutral contracts for Kunlun Engine. It defines Fetch-compatible applications, runtime adapters, server lifecycle, and an explicit capability registry.

```ts
import { CapabilityRegistry } from '@kunlun-js/runtime-api'

const capabilities = new CapabilityRegistry()
  .bind('database.orders', database)
```
