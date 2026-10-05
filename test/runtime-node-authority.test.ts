import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeHttp from 'node:http'
import { createServer, type Server, type RequestListener } from 'node:http'
import { runInNewContext } from 'node:vm'
import { gzipSync } from 'node:zlib'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
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
async function listener(handler: RequestListener, hostname = '127.0.0.1') {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, hostname, resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return `http://${hostname}:${address.port}`
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

  it('denies escaped redirects even to another admitted host before any destination traffic', async () => {
    let hits = 0
    let forbiddenHits = 0
    const destination = await listener((_request, response) => { forbiddenHits++; response.end('forbidden') })
    const location = destination.replace('127.0.0.1', 'localhost') + '/private?secret=credential'
    const base = await listener((_request, response) => {
      hits++
      response.writeHead(302, { location })
      response.end('redirect')
    })
    const host = await authority({
      required: [{ name: 'http.host', resource: '127.0.0.1' }, { name: 'http.host', resource: 'localhost' }], optional: [],
    }, { http: ['127.0.0.1', 'localhost'] })
    await host.invoke(async env => {
      const handle = env.http['127.0.0.1']!
      await expect(handle.fetch(base)).rejects.toThrow(NodeAuthorityError)
      await expect(handle.fetch(base, { redirect: 'follow' })).rejects.toThrow('Request authority denied or ended')
      const result = await handle.fetch(base, { redirect: 'manual' })
      expect(result.status).toBe(302)
      expect(result.headers.get('location')).toBe(location)
      expect(result.redirected).toBe(false)
      expect(await result.text()).toBe('redirect')
      for (const url of ['http://localhost/', 'file:///secret', 'http://user:password@127.0.0.1/']) {
        await expect(handle.fetch(url)).rejects.toThrow(NodeAuthorityError)
      }
      await expect(handle.fetch.call({ ...handle }, base)).rejects.toThrow(NodeAuthorityError)
      await expect(handle.fetch(base, { headers: { host: 'other.example' } })).rejects.toThrow(NodeAuthorityError)
    })
    expect(hits).toBe(3)
    expect(forbiddenHits).toBe(0)
  })

  it('follows relative same-host redirects and reports the final URL', async () => {
    const traffic: string[] = []
    const base = await listener((request, response) => {
      traffic.push(request.url!)
      if (request.url === '/start') response.writeHead(302, { location: 'middle' }).end('discard')
      else if (request.url === '/middle') response.writeHead(307, { location: '/ok' }).end('discard')
      else response.end('allowed')
    })
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    await host.invoke(async env => {
      for (const init of [undefined, { redirect: 'follow' as const }]) {
        const result = await env.http['127.0.0.1']!.fetch(base + '/start', init)
        expect(result.status).toBe(200)
        expect(result.url).toBe(base + '/ok')
        expect(result.redirected).toBe(true)
        const clone = result.clone()
        const secondClone = clone.clone()
        for (const copy of [clone, secondClone]) {
          expect(copy.url).toBe(result.url)
          expect(copy.redirected).toBe(true)
          expect(copy.type).toBe(result.type)
        }
        expect(await Promise.all([result.text(), clone.text(), secondClone.text()])).toEqual(['allowed', 'allowed', 'allowed'])
      }
    })
    expect(traffic).toEqual(['/start', '/middle', '/ok', '/start', '/middle', '/ok'])
  })

  it('checks the connection origin rather than treating a double-slash path as authority', async () => {
    let forbiddenHits = 0
    const destination = await listener((_request, response) => { forbiddenHits++; response.end('other host') }, 'localhost')
    const base = await listener((request, response) => {
      if (request.url === '/escape') response.writeHead(302, { location: destination + '//127.0.0.1/private' }).end()
      else response.end('allowed path')
    })
    const host = await authority({
      required: [{ name: 'http.host', resource: '127.0.0.1' }, { name: 'http.host', resource: 'localhost' }], optional: [],
    }, { http: ['127.0.0.1', 'localhost'] })
    await host.invoke(async env => {
      // Verify the forbidden destination really is reachable, not just refusing
      // an unauthorized connection which could otherwise mask a gate bypass.
      expect(await (await env.http.localhost!.fetch(destination)).text()).toBe('other host')
      forbiddenHits = 0
      await expect(env.http['127.0.0.1']!.fetch(base + '/escape')).rejects.toThrow(NodeAuthorityError)
      expect(await (await env.http['127.0.0.1']!.fetch(base + '//localhost/allowed')).text()).toBe('allowed path')
    })
    expect(forbiddenHits).toBe(0)
  })

  it('applies the same destination checks at later hops and rejects unsafe Location URLs', async () => {
    const traffic: string[] = []
    const base = await listener((request, response) => {
      traffic.push(request.url!)
      const location = request.url === '/first' ? '/escape' : request.url === '/escape'
        ? 'http://localhost/forbidden'
        : decodeURIComponent(request.url!.slice(1))
      response.writeHead(302, { location }).end()
    })
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    await host.invoke(async env => {
      const handle = env.http['127.0.0.1']!
      await expect(handle.fetch(base + '/first')).rejects.toThrow(NodeAuthorityError)
      for (const location of ['file:///secret', 'data:text/plain,private', 'http://user:password@127.0.0.1/', 'http://[invalid']) {
        const url = base + '/' + encodeURIComponent(location)
        await expect(handle.fetch(url)).rejects.toThrow('Request authority denied or ended')
      }
    })
    expect(traffic.slice(0, 2)).toEqual(['/first', '/escape'])
    expect(traffic).toHaveLength(6)
  })

  it('denies credential-bearing redirect URLs regardless of caller-controlled Request mode', async () => {
    let forbiddenHits = 0
    const base = await listener((request, response) => {
      if (request.url === '/forbidden') { forbiddenHits++; response.end('escaped') }
      else response.writeHead(302, { location: base.replace('http://', 'http://user:password@') + '/forbidden' }).end()
    })
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    await host.invoke(async env => {
      for (const mode of ['cors', 'same-origin', 'no-cors'] as const) {
        await expect(env.http['127.0.0.1']!.fetch(new Request(base, { mode }))).rejects.toThrow(NodeAuthorityError)
        const manual = await env.http['127.0.0.1']!.fetch(new Request(base, { mode, redirect: 'manual' }))
        expect(manual.status).toBe(302)
        expect(manual.headers.get('location')).toContain('user:password@')
        await manual.body!.cancel()
      }
    })
    expect(forbiddenHits).toBe(0)
  })

  it('returns manual redirects and rejects error mode without following or draining a stalled body', async () => {
    const traffic: string[] = []
    const base = await listener((request, response) => {
      traffic.push(request.url!)
      response.writeHead(302, { location: '/never' })
      response.write('redirect')
      // Deliberately never end: redirect/error cleanup must not drain this body.
    })
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    await host.invoke(async env => {
      const handle = env.http['127.0.0.1']!
      const result = await handle.fetch(base + '/manual', { redirect: 'manual' })
      expect(result.status).toBe(302)
      expect(result.headers.get('location')).toBe('/never')
      await result.body!.cancel()
      await expect(handle.fetch(base + '/error', { redirect: 'error' })).rejects.toThrow(NodeAuthorityError)
    })
    expect(traffic).toEqual(['/manual', '/error'])
  })

  it('permits 20 redirects but rejects hop 21 and releases the host-call budget after denial', async () => {
    let hits = 0
    const base = await listener((request, response) => {
      hits++
      const count = Number(request.url!.slice(1))
      if (count === 0) response.end('done')
      else response.writeHead(302, { location: `/${count - 1}` }).end()
    })
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    await host.invoke(async env => {
      const handle = env.http['127.0.0.1']!
      expect(await (await handle.fetch(base + '/20')).text()).toBe('done')
      expect(hits).toBe(21)
      await expect(handle.fetch(base + '/21')).rejects.toThrow(NodeAuthorityError)
      expect(hits).toBe(42)
      for (let index = 0; index < 256; index++) {
        await expect(handle.fetch(base + '/21')).rejects.toThrow(NodeAuthorityError)
      }
      expect(await (await handle.fetch(base + '/0')).text()).toBe('done')
    })
  })

  it('rewrites methods and body headers, preserves HEAD, and replays buffered bodies including Request inputs', async () => {
    const received: { path: string; method: string; body: string; headers: nodeHttp.IncomingHttpHeaders }[] = []
    const base = await listener(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      received.push({ path: request.url!, method: request.method!, body: Buffer.concat(chunks).toString(), headers: request.headers })
      if (request.url!.startsWith('/redirect/')) response.writeHead(Number(request.url!.split('/')[2]), { location: '/final' }).end()
      else response.end('done')
    })
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    await host.invoke(async env => {
      for (const [status, method, finalMethod] of [
        [301, 'POST', 'GET'], [302, 'POST', 'GET'], [303, 'PUT', 'GET'],
        [303, 'HEAD', 'HEAD'], [301, 'PUT', 'PUT'], [307, 'POST', 'POST'], [308, 'POST', 'POST'],
      ] as const) {
        const input = new Request(`${base}/redirect/${status}`, {
          method, ...(method === 'HEAD' ? {} : { body: 'pay' }),
          headers: {
            'content-type': 'application/example', 'content-encoding': 'identity',
            'content-language': 'en', 'content-location': '/source', 'x-retained': 'yes',
          },
        })
        const result = await env.http['127.0.0.1']!.fetch(input)
        expect(result.status).toBe(200)
        expect(await result.text()).toBe(method === 'HEAD' ? '' : 'done')
        const final = received.at(-1)!
        expect(final.method).toBe(finalMethod)
        expect(final.body).toBe(finalMethod === 'GET' || finalMethod === 'HEAD' ? '' : 'pay')
        expect(final.headers['x-retained']).toBe('yes')
        for (const header of ['content-type', 'content-encoding', 'content-language', 'content-location']) {
          expect(final.headers[header]).toBe(finalMethod === 'GET' ? undefined : input.headers.get(header))
        }
      }
    })
    expect(received).toHaveLength(14)
  })

  it('replays explicit binary BodyInit without detaching the caller buffer on supported Node engines', async () => {
    const received: Buffer[] = []
    const base = await listener(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      received.push(Buffer.concat(chunks))
      if (request.url === '/start') response.writeHead(308, { location: '/final' }).end()
      else response.end('done')
    })
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    const bytes = new Uint8Array([1, 2, 3])
    const realmBytes = runInNewContext('new Uint8Array([1, 2, 3])') as Uint8Array
    await host.invoke(async env => {
      for (const body of [bytes, bytes.buffer, new DataView(bytes.buffer), realmBytes, new Blob([bytes])]) {
        let reads = 0
        const prototype = { method: 'POST', get body() { reads++; return body } }
        const init = Object.create(prototype) as RequestInit
        expect(await (await env.http['127.0.0.1']!.fetch(base + '/start', init)).text()).toBe('done')
        expect(reads).toBe(1)
      }
    })
    expect([...bytes]).toEqual([1, 2, 3])
    expect([...realmBytes]).toEqual([1, 2, 3])
    expect(received).toHaveLength(10)
    for (const body of received) expect([...body]).toEqual([1, 2, 3])
  })

  it('normalizes frozen binary request options without mutating the caller', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const init = Object.freeze({ method: 'POST', body: bytes })
    const base = await listener(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      response.end(Buffer.concat(chunks))
    })
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    await host.invoke(async env => {
      const result = await env.http['127.0.0.1']!.fetch(base, init)
      expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([1, 2, 3])
    })
    expect(init.body).toBe(bytes)
    expect([...bytes]).toEqual([1, 2, 3])
    expect(Object.isFrozen(init)).toBe(true)
  })

  it('strips sensitive headers on same-host cross-origin redirects and regenerates Host', async () => {
    const received: nodeHttp.IncomingHttpHeaders[] = []
    const destination = await listener((request, response) => { received.push(request.headers); response.end('done') })
    const base = await listener((request, response) => {
      received.push(request.headers)
      response.writeHead(302, { location: destination }).end()
    })
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    await host.invoke(async env => {
      const result = await env.http['127.0.0.1']!.fetch(base, {
        headers: { authorization: 'private', cookie: 'private', 'proxy-authorization': 'private', host: new URL(base).host },
      })
      expect(await result.text()).toBe('done')
    })
    expect(received).toHaveLength(2)
    for (const header of ['authorization', 'cookie', 'proxy-authorization']) {
      expect(received[0]![header]).toBe('private')
      expect(received[1]![header]).toBeUndefined()
    }
    expect(received[1]!.host).toBe(new URL(destination).host)
  })

  it('rejects streaming-body replay instead of buffering or resending a consumed stream', async () => {
    const traffic: string[] = []
    const base = await listener(async (request, response) => {
      for await (const _chunk of request) {}
      traffic.push(request.url!)
      response.writeHead(Number(request.url!.slice(1)), { location: '/never' }).end()
    })
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    await host.invoke(async env => {
      for (const status of [307, 308]) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close() },
        })
        const input = new Request(`${base}/${status}`, { method: 'POST', body, duplex: 'half' } as RequestInit)
        await expect(env.http['127.0.0.1']!.fetch(input)).rejects.toThrow(NodeAuthorityError)
      }
    })
    expect(traffic).toEqual(['/307', '/308'])
  })

  it('accepts streamed bytes from an artifact realm but only permits a 303 rewrite', async () => {
    const traffic: string[] = []
    const base = await listener(async (request, response) => {
      for await (const _chunk of request) {}
      traffic.push(request.url!)
      if (request.url === '/final') response.end(request.method)
      else response.writeHead(Number(request.url!.slice(1)), { location: '/final' }).end()
    })
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    await host.invoke(async env => {
      for (const status of [301, 302, 303, 307, 308]) {
        const body = runInNewContext(`new ReadableStream({
          start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close() }
        })`, { ReadableStream }) as ReadableStream<Uint8Array>
        const input = new Request(`${base}/${status}`, { method: 'POST', body, duplex: 'half' } as RequestInit)
        if (status === 303) expect(await (await env.http['127.0.0.1']!.fetch(input)).text()).toBe('GET')
        else await expect(env.http['127.0.0.1']!.fetch(input)).rejects.toThrow(NodeAuthorityError)
      }
    })
    expect(traffic).toEqual(['/301', '/302', '/303', '/final', '/307', '/308'])
  })

  it('aborts between redirect hops without following and leaves later calls in the scope usable', async () => {
    let acknowledge!: () => void
    const received = new Promise<void>(resolve => { acknowledge = resolve })
    let redirect!: nodeHttp.ServerResponse
    const traffic: string[] = []
    const base = await listener((request, response) => {
      traffic.push(request.url!)
      if (request.url === '/first') { redirect = response; acknowledge() }
      else response.end('allowed')
    })
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    await host.invoke(async env => {
      const controller = new AbortController()
      const pending = env.http['127.0.0.1']!.fetch(base + '/first', { signal: controller.signal })
      const rejected = expect(pending).rejects.toThrow(NodeAuthorityError)
      await received
      controller.abort()
      await rejected
      redirect.writeHead(302, { location: '/never' }).end()
      expect(await (await env.http['127.0.0.1']!.fetch(base + '/ok')).text()).toBe('allowed')
    })
    expect(traffic).toEqual(['/first', '/ok'])
  })

  it('cancels a stalled upload when an early redirect cannot replay it', async () => {
    let canceled!: () => void
    const cancellation = new Promise<void>(resolve => { canceled = resolve })
    const base = await listener((request, response) => {
      request.once('data', () => response.writeHead(307, { location: '/never' }).end())
    })
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    await host.invoke(async env => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])) },
        pull() { return new Promise<void>(() => {}) },
        cancel() { canceled() },
      })
      const input = new Request(base, { method: 'POST', body, duplex: 'half' } as RequestInit)
      await expect(env.http['127.0.0.1']!.fetch(input)).rejects.toThrow(NodeAuthorityError)
    })
    await cancellation
  }, 3_000)

  it('ignores the ambient Fetch dispatcher through allowed redirects', async () => {
    let ambientHits = 0
    const previous = getGlobalDispatcher()
    const ambient = new Agent({
      connect(_options, callback) { ambientHits++; callback(new Error('ambient transport'), null) },
    })
    setGlobalDispatcher(ambient)
    try {
      const base = await listener((request, response) => {
        if (request.url === '/start') response.writeHead(302, { location: '/ok' }).end()
        else response.end('direct')
      })
      const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
      await host.invoke(async env => {
        expect(await (await env.http['127.0.0.1']!.fetch(base + '/start')).text()).toBe('direct')
      })
      expect(ambientHits).toBe(0)
    } finally { setGlobalDispatcher(previous); await ambient.destroy() }
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

  it('bounds both encoded wire bytes and decoded response bytes', async () => {
    // Concatenated empty members consume >1 MiB on the wire but decode to zero.
    const member = gzipSync(Buffer.alloc(0))
    const encoded = Buffer.concat(Array<Buffer>(60_000).fill(member))
    const decoded = gzipSync(Buffer.alloc(1024 * 1024 + 1))
    const base = await listener((request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip' })
      // Explicit writes use chunked transfer; no Content-Length check can substitute.
      response.write(request.url === '/wire' ? encoded : decoded)
      response.end()
    })
    const host = await authority({ required: [{ name: 'http.host', resource: '127.0.0.1' }], optional: [] }, { http: ['127.0.0.1'] })
    await host.invoke(async env => {
      for (const path of ['/wire', '/decoded']) {
        await expect(env.http['127.0.0.1']!.fetch(base + path).then(response => response.text())).rejects.toThrow(NodeAuthorityError)
      }
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
