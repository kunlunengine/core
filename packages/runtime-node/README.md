# @kunlun-js/runtime-node

The Node.js reference runtime for Kunlun Engine. It translates Node HTTP requests and responses to the Web Fetch API used by Kunlun applications.

```ts
import { nodeRuntime } from '@kunlun-js/runtime-node'

const server = await nodeRuntime().start(application, { port: 3000 })
console.log(server.url)
```
