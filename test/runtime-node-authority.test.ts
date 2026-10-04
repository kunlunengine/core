import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeHttp from 'node:http'
import { createServer, type Server, type RequestListener } from 'node:http'
import type { RuntimeRequestEnvironment, RuntimeCapabilityRequirements } from '../packages/runtime-api/src/artifact.js'
import { createRequestAuthority, NodeAuthorityError, type NodeRequestAuthority, type NodeDeploymentGrants } from '../packages/runtime-node/src/authority.js'

let directory: string
let root: string
const authorities: NodeRequestAuthority[] = []
const servers: Server[] = []
const requirements: RuntimeCapabilityRequirements = {
  required: [{ name: 'fs.binding', resource: 'public-data' }],
  optional: [{ name: 'fs.binding', resource: 'absent' }],
}
async function authority(caps = requirements, grants: NodeDeploymentGrants = { fs: { 'public-data': root } }) {
  const result = await createRequestAuthority(caps, grants)
  authorities.push(result)
  return result
}
async function listener(handler: RequestListener) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return `http://127.0.0.1:${address.port}`
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'authority-'))
  root = join(directory, 'root')
  await mkdir(root)
  await writeFile(join(root, 'message.txt'), 'permitted')
  await writeFile(join(directory, 'secret.txt'), 'private')
  await symlink(join(directory, 'secret.txt'), join(root, 'escape'))
})
afterEach(async () => {
  await Promise.all(authorities.splice(0).map(item => item.close()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
  await rm(directory, { recursive: true, force: true })
})

describe('Node request authority', () => {
  it('admits the intersection only, validates even optional entries, and redacts roots', async () => {
    await expect(createRequestAuthority(requirements, {})).rejects.toThrow(NodeAuthorityError)
    for (const entry of [
      { name: 'unknown', resource: 'x' },
      { name: 'http.host', resource: 'LOCALHOST' },
      { name: 'http.host', resource: 'localhost:80' },
      { name: 'fs.binding', resource: 'a/b' },
      { name: 'fs.binding', resource: 'public-data' },
      { name: 'fs.binding', resource: 'x', unexpected: true },
      Object.assign([], { name: 'http.host', resource: '127.0.0.1' }),
    ]) {
      await expect(createRequestAuthority({ ...requirements, optional: [entry] } as RuntimeCapabilityRequirements, {
        fs: { 'public-data': root }, http: ['127.0.0.1'],
      })).rejects.toThrow(NodeAuthorityError)
    }
    await expect(createRequestAuthority(requirements, { fs: { 'public-data': join(directory, 'secret.txt') } })).rejects.toThrow('Request authority denied or ended')
    const host = await authority(requirements, { fs: { 'public-data': root, extra: root } })
    await host.invoke(env => {
      expect(Object.keys(env.fs)).toEqual(['public-data'])
      for (const item of [env, env.fs, env.http, env.fs['public-data']]) {
        expect(Object.isFrozen(item)).toBe(true)
        expect(Object.getPrototypeOf(item)).toBe(null)
        expect(() => JSON.stringify(item)).toThrow(NodeAuthorityError)
      }
    })
  })

  it('reads real files but rejects traversal, escapes, forged receivers, oversize and invalid UTF8', async () => {
    await writeFile(join(root, 'large'), Buffer.alloc(1024 * 1024 + 1))
    await writeFile(join(root, 'invalid'), Buffer.from([0xff]))
    const host = await authority()
    await host.invoke(async env => {
      const handle = env.fs['public-data']!
      expect(await handle.readTextFile('message.txt')).toBe('permitted')
      for (const path of ['../secret.txt', 'a/../message.txt', join(root, 'message.txt'), 'escape', 'missing', 'large', 'invalid', '.']) {
        await expect(handle.readTextFile(path)).rejects.toThrow('Request authority denied or ended')
      }
      await expect(handle.readTextFile.call({ ...handle }, 'message.txt')).rejects.toThrow(NodeAuthorityError)
      await expect(handle.readTextFile.call(undefined, 'message.txt')).rejects.toThrow(NodeAuthorityError)
    })
  })

  it('does not reserve otherwise valid filesystem labels', async () => {
    const host = await authority({ required: [{ name: 'fs.binding', resource: 'toJSON' }], optional: [] }, { fs: { toJSON: root } })
    await host.invoke(async env => {
      expect(await env.fs.toJSON!.readTextFile('message.txt')).toBe('permitted')
      expect(() => JSON.stringify(env.fs)).toThrow(NodeAuthorityError)
    })
  })

  it('does not follow replacement of an admitted filesystem root', async () => {
    const host = await authority()
    await rename(root, join(directory, 'original-root'))
    await mkdir(root)
    await writeFile(join(root, 'message.txt'), 'replacement private data')
    await host.invoke(async env => {
      await expect(env.fs['public-data']!.readTextFile('message.txt')).rejects.toThrow(NodeAuthorityError)
    })
  })

  it('uses Runtime URL canonicalization rather than an independent DNS-label policy', async () => {
    const hosts = ['localhost.', 'api_example.test', 'xn--bcher-kva.example', '[::1]']
    const host = await authority({
      required: hosts.map(resource => ({ name: 'http.host' as const, resource })), optional: [],
    }, { http: hosts })
    await host.invoke(env => { expect(Object.keys(env.http)).toEqual(hosts) })
  })

  it('snapshots admission policy before asynchronous root validation', async () => {
    const optional = [{ name: 'http.host' as const, resource: 'localhost' }]
    const grants = { fs: { 'public-data': root }, http: ['localhost'] }
    const pending = authority({ required: requirements.required, optional }, grants)
    optional[0]!.resource = 'other.example'
    grants.http[0] = 'other.example'
    const host = await pending
    await host.invoke(env => { expect(Object.keys(env.http)).toEqual(['localhost']) })
  })

  it('bounds concurrent filesystem work with the same host-call budget', async () => {
    const host = await authority()
    await host.invoke(async env => {
      const calls = Array.from({ length: 257 }, () => env.fs['public-data']!.readTextFile('message.txt'))
      const results = await Promise.allSettled(calls)
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(256)
      expect(results[256]!.status).toBe('rejected')
      expect(await env.fs['public-data']!.readTextFile('message.txt')).toBe('permitted')
    })
  })

  it('separates concurrent and nested authorities and revokes successful and failed scopes', async () => {
    const host = await authority()
    const other = await authority()
    let retained!: RuntimeRequestEnvironment
    await host.invoke(async env => {
      retained = env
      await other.invoke(async () => {
        await expect(env.fs['public-data']!.readTextFile('message.txt')).rejects.toThrow(NodeAuthorityError)
      })
      expect(await env.fs['public-data']!.readTextFile('message.txt')).toBe('permitted')
    })
    await host.invoke(async () => {
      await expect(retained.fs['public-data']!.readTextFile('message.txt')).rejects.toThrow(NodeAuthorityError)
    })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let first!: RuntimeRequestEnvironment
    const a = host.invoke(async env => { first = env; await gate; return env.fs['public-data']!.readTextFile('message.txt') })
    const b = host.invoke(async env => {
      await expect(first.fs['public-data']!.readTextFile('message.txt')).rejects.toThrow(NodeAuthorityError)
      release()
      return env.fs['public-data']!.readTextFile('message.txt')
    })
    expect(await Promise.all([a, b])).toEqual(['permitted', 'permitted'])
    await expect(host.invoke(env => { retained = env; throw new Error('app failure') })).rejects.toThrow('app failure')
    await expect(retained.fs['public-data']!.readTextFile('message.txt')).rejects.toThrow(NodeAuthorityError)
  })

  it('uses real direct HTTP and returns redirects manually even with follow requested', async () => {
    let hits = 0
    const base = await listener((_request, response) => {
      hits++
      response.writeHead(302, { location: 'http://localhost/next' })
      response.end('redirect')
    })
    const host = await authority({
      required: [{ name: 'http.host', resource: '127.0.0.1' }, { name: 'http.host', resource: 'localhost' }], optional: [],
    }, { http: ['127.0.0.1', 'localhost'] })
    await host.invoke(async env => {
      const handle = env.http['127.0.0.1']!
      const result = await handle.fetch(base, { redirect: 'follow' })
      expect(result.status).toBe(302)
      expect(await result.text()).toBe('redirect')
      for (const url of ['http://localhost/', 'file:///secret', 'http://user:password@127.0.0.1/']) {
        await expect(handle.fetch(url)).rejects.toThrow(NodeAuthorityError)
      }
      await expect(handle.fetch.call({ ...handle }, base)).rejects.toThrow(NodeAuthorityError)
      await expect(handle.fetch(base, { headers: { host: 'other.example' } })).rejects.toThrow(NodeAuthorityError)
    })
    expect(hits).toBe(1)
  })

  it('keeps returned application streams alive in their owning context, then revokes on EOF and cancel', async () => {
    const host = await authority()
    let retained!: RuntimeRequestEnvironment
    const response = await host.fetch(new Request('http://application/'), (_request, env) => {
      retained = env
      let sent = false
      return new Response(new ReadableStream({
        async pull(controller) {
          if (sent) { controller.close(); return }
          sent = true
          controller.enqueue(new TextEncoder().encode(await env.fs['public-data']!.readTextFile('message.txt')))
        },
      }, { highWaterMark: 0 }))
    })
    expect(await response.text()).toBe('permitted')
    await expect(retained.fs['public-data']!.readTextFile('message.txt')).rejects.toThrow(NodeAuthorityError)
    const canceled = await host.fetch(new Request('http://application/'), (_request, env) => {
      retained = env
      return new Response(new ReadableStream({}, { highWaterMark: 0 }))
    })
    await canceled.body!.cancel()
    await expect(retained.fs['public-data']!.readTextFile('message.txt')).rejects.toThrow(NodeAuthorityError)
  })

  it('denies captured transport streams after scope completion and cancels in-flight calls on abort/close', async () => {
    let arrived!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const base = await listener((_request, response) => {
      response.writeHead(200)
      response.write('chunk')
      arrived()
    })
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    const captured = await host.invoke(env => env.http['127.0.0.1']!.fetch(base))
    await expect(captured.text()).rejects.toThrow(NodeAuthorityError)
    await expect(captured.body?.cancel()).rejects.toThrow()
    const abort = new AbortController()
    const pending = host.invoke(async env => {
      const result = await env.http['127.0.0.1']!.fetch(base)
      return result.text()
    }, { signal: abort.signal })
    await arrival
    abort.abort()
    await expect(pending).rejects.toThrow(NodeAuthorityError)
    const never = host.invoke(() => new Promise<void>(() => {}))
    const rejected = expect(never).rejects.toThrow(NodeAuthorityError)
    await host.close()
    await rejected
    await expect(host.invoke(() => 1)).rejects.toThrow(NodeAuthorityError)
  })

  it('bounds HTTP response bytes and redacts transport errors', async () => {
    const base = await listener((_request, response) => response.end(Buffer.alloc(1024 * 1024 + 1)))
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    await host.invoke(async env => {
      await expect((await env.http['127.0.0.1']!.fetch(base)).text()).rejects.toThrow(NodeAuthorityError)
      await expect(env.http['127.0.0.1']!.fetch('http://127.0.0.1:1/private')).rejects.toThrow('Request authority denied or ended')
    })
  })

  it('projects a request signal that aborts on authority shutdown and external cancellation', async () => {
    for (const external of [false, true]) {
      const host = await authority()
      const controller = new AbortController()
      let observed!: AbortSignal
      let started!: () => void
      const ready = new Promise<void>(resolve => { started = resolve })
      const pending = host.fetch(new Request('http://application/', { signal: controller.signal }), (request, _env, context) => {
        observed = context.signal
        expect(context.signal).toBe(request.signal)
        expect(Object.isFrozen(context)).toBe(true)
        expect(() => context.waitUntil(Promise.resolve())).toThrow('unsupported')
        started()
        return new Promise<Response>(() => {})
      })
      await ready
      const rejected = expect(pending).rejects.toThrow(NodeAuthorityError)
      if (external) controller.abort()
      else await host.close()
      expect(observed.aborted).toBe(true)
      await rejected
    }
  })

  it('rejects malformed handler results and revokes their request environment', async () => {
    const host = await authority()
    let retained!: RuntimeRequestEnvironment
    await expect(host.fetch(new Request('http://application/'), (_request, env) => {
      retained = env
      return { body: null } as Response
    })).rejects.toThrow('Runtime handler must return a Response')
    await expect(retained.fs['public-data']!.readTextFile('message.txt')).rejects.toThrow(NodeAuthorityError)
  })

  it('cancels a response body returned after request cancellation already won', async () => {
    const host = await authority()
    const controller = new AbortController()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let canceled!: () => void
    const discarded = new Promise<void>(resolve => { canceled = resolve })
    const pending = host.fetch(new Request('http://application/', { signal: controller.signal }), async () => {
      started()
      await gate
      return new Response(new ReadableStream({ cancel() { canceled() } }, { highWaterMark: 0 }))
    })
    await ready
    const rejected = expect(pending).rejects.toThrow(NodeAuthorityError)
    controller.abort()
    await rejected
    release()
    await discarded
  })

  it('owns HTTP streams across application response delivery and revokes bodyless responses immediately', async () => {
    const base = await listener((_request, response) => response.end('real streamed data'))
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    const result = await host.fetch(new Request('http://application/'), (_request, env) => env.http['127.0.0.1']!.fetch(base))
    expect(await result.text()).toBe('real streamed data')
    let retained!: RuntimeRequestEnvironment
    await host.fetch(new Request('http://application/'), (_request, env) => {
      retained = env
      return new Response(null, { status: 204 })
    })
    await expect(retained.http['127.0.0.1']!.fetch(base)).rejects.toThrow(NodeAuthorityError)
  })

  it('bounds real uploads and caps authority-wide concurrent HTTP operations', async () => {
    const base = await listener((_request, response) => {
      response.writeHead(200)
      response.write('held')
    })
    const host = await authority({
      required: [...requirements.required, { name: 'http.host', resource: '127.0.0.1' }], optional: [],
    }, { fs: { 'public-data': root }, http: ['127.0.0.1'] })
    await host.invoke(async env => {
      await expect(env.http['127.0.0.1']!.fetch(base, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).rejects.toThrow(NodeAuthorityError)
      // Establish sequentially to avoid platform-dependent listener backlog limits.
      const responses: Response[] = []
      for (let index = 0; index < 256; index++) responses.push(await env.http['127.0.0.1']!.fetch(base))
      await expect(env.http['127.0.0.1']!.fetch(base)).rejects.toThrow(NodeAuthorityError)
      await expect(env.fs['public-data']!.readTextFile('message.txt')).rejects.toThrow(NodeAuthorityError)
      await Promise.all(responses.map(response => response.body!.cancel()))
    })
  })

  it('ignores configured global proxy transport where Node supports it', async () => {
    const setProxy = (nodeHttp as unknown as {
      setGlobalProxyFromEnv?: (settings: Record<string, string>) => () => void
    }).setGlobalProxyFromEnv
    if (!setProxy) return // Node 20 has no built-in global proxy feature.
    let proxyHits = 0
    const proxy = await listener((_request, response) => { proxyHits++; response.end('proxy') })
    const destination = await listener((_request, response) => response.end('direct'))
    const restore = setProxy({ http_proxy: proxy, https_proxy: proxy, no_proxy: '' })
    try {
      const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
      await host.invoke(async env => {
        expect(await (await env.http['127.0.0.1']!.fetch(destination)).text()).toBe('direct')
      })
      expect(proxyHits).toBe(0)
    } finally { restore() }
  })
})
