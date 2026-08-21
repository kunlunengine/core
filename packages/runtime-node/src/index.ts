import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
  CorsSetting,
  RuntimeAdapter,
  RuntimeApplication,
  RuntimeServer,
  RuntimeStartOptions,
} from '@kunlun-js/runtime-api'

const DEFAULT_OPTIONS = Object.freeze({
  host: '127.0.0.1',
  port: 3000,
  mode: 'production' as const,
  shutdownGracePeriodMs: 5_000,
})

export function nodeRuntime(defaults: RuntimeStartOptions = {}): RuntimeAdapter {
  return {
    name: 'node',
    displayName: 'Node.js reference runtime',
    async start(application, options = {}) {
      return startNodeRuntime(application, { ...defaults, ...options })
    },
  }
}

async function startNodeRuntime(
  application: RuntimeApplication,
  options: RuntimeStartOptions,
): Promise<RuntimeServer> {
  const host = options.host ?? DEFAULT_OPTIONS.host
  const port = options.port ?? DEFAULT_OPTIONS.port
  const gracePeriod = options.shutdownGracePeriodMs ?? DEFAULT_OPTIONS.shutdownGracePeriodMs
  assertPort(port)
  if (!Number.isFinite(gracePeriod) || gracePeriod < 0) {
    throw new TypeError(`Invalid shutdown grace period: ${gracePeriod}`)
  }

  const server = createServer(async (incoming, outgoing) => {
    let request: Request | undefined
    try {
      request = toRequest(incoming)
      const response = request.method === 'OPTIONS' && options.cors
        ? new Response(null, { status: 204 })
        : await application.fetch(request)
      await sendResponse(outgoing, withCors(response, options.cors))
    } catch (error) {
      await options.onError?.(error, request)
      if (!outgoing.headersSent) {
        await sendResponse(outgoing, Response.json({ error: 'Internal Server Error' }, { status: 500 }))
      } else if (!outgoing.destroyed) {
        outgoing.destroy(error instanceof Error ? error : undefined)
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Node runtime did not expose a TCP address')
  }

  const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    options.signal?.removeEventListener('abort', closeOnAbort)

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.closeAllConnections()
      }, gracePeriod)
      timer.unref()
      server.close((error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      })
      server.closeIdleConnections()
    })
  }
  const closeOnAbort = () => void close()
  options.signal?.addEventListener('abort', closeOnAbort, { once: true })
  if (options.signal?.aborted) await close()

  return {
    adapter: 'node',
    address: { host: address.address, port: address.port, family: address.family },
    url: `http://${displayHost}:${address.port}`,
    fetch: application.fetch,
    close,
  }
}

function toRequest(incoming: IncomingMessage): Request {
  const headers = new Headers()
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index]
    const value = incoming.rawHeaders[index + 1]
    if (name && value !== undefined) headers.append(name, value)
  }

  const method = (incoming.method ?? 'GET').toUpperCase()
  const init: RequestInit & { duplex?: 'half' } = { method, headers }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(incoming) as BodyInit
    init.duplex = 'half'
  }
  return new Request(`http://${incoming.headers.host ?? 'localhost'}${incoming.url ?? '/'}`, init)
}

async function sendResponse(outgoing: ServerResponse, response: Response): Promise<void> {
  outgoing.statusCode = response.status
  outgoing.statusMessage = response.statusText

  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie') outgoing.setHeader(name, value)
  }
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const cookies = getSetCookie?.call(response.headers)
  if (cookies?.length) outgoing.setHeader('set-cookie', cookies)
  else {
    const cookie = response.headers.get('set-cookie')
    if (cookie) outgoing.setHeader('set-cookie', cookie)
  }

  if (!response.body) {
    outgoing.end()
    return
  }
  await pipeline(Readable.fromWeb(response.body as never), outgoing)
}

function withCors(response: Response, setting: CorsSetting | undefined): Response {
  if (!setting) return response
  const headers = new Headers(response.headers)
  const origins = setting === true ? '*' : typeof setting === 'string' ? setting : setting.join(', ')
  headers.set('access-control-allow-origin', origins)
  headers.set('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
  headers.set('access-control-allow-headers', 'content-type, authorization')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError(`Invalid port: ${port}`)
}
