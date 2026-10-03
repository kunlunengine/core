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

export {
  createRequestAuthority,
  type NodeDeploymentGrants,
  type NodeRequestAuthority,
} from './authority.js'
export {
  createNodeApplication,
  loadNodeApplication,
} from './application.js'

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

  let closePromise: Promise<void> | undefined
  const dispatch = (request: Request): Promise<Response> => {
    if (closePromise) return Promise.reject(new Error('Node runtime is closed'))
    return Promise.resolve().then(async () => {
      const response = await application.fetch(request)
      if (!(response instanceof Response)) throw new TypeError('Runtime handler must return a Response')
      return response
    })
  }
  const reportError = async (error: unknown, request?: Request) => {
    try {
      await options.onError?.(error, request)
    } catch {
      // Diagnostics must not change HTTP behavior or escape an event listener.
    }
  }
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    const onClose = () => {
      if (!outgoing.writableFinished) abort()
    }
    incoming.once('aborted', abort)
    outgoing.once('close', onClose)
    let request: Request | undefined
    try {
      request = toRequest(incoming, controller.signal)
      if (closePromise) throw new Error('Node runtime is closed')
      const response = request.method === 'OPTIONS' && options.cors
        ? new Response(null, { status: 204 })
        : await dispatch(request)
      await sendResponse(outgoing, withCors(response, options.cors), request.method === 'HEAD')
    } catch (error) {
      await reportError(error, request)
      try {
        if (!outgoing.destroyed && !outgoing.headersSent) {
          await sendResponse(outgoing, Response.json({ error: 'Internal Server Error' }, { status: 500 }), request?.method === 'HEAD')
        } else if (!outgoing.destroyed) {
          outgoing.destroy(error instanceof Error ? error : undefined)
        }
      } catch (sendError) {
        await reportError(sendError, request)
        outgoing.destroy()
      }
    } finally {
      incoming.off('aborted', abort)
      outgoing.off('close', onClose)
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
  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    // Defer application cleanup until the shared promise has stopped admissions.
    closePromise = Promise.resolve().then(async () => {
      const transportClosed = new Promise<void>((resolve, reject) => {
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
      const results = await Promise.allSettled([
        transportClosed,
        Promise.resolve().then(() => application.close?.()),
      ])
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason
      }
    })
    options.signal?.removeEventListener('abort', closeOnAbort)
    return closePromise
  }
  const closeOnAbort = () => { void close().catch((error) => reportError(error)) }
  options.signal?.addEventListener('abort', closeOnAbort, { once: true })
  if (options.signal?.aborted) await close()

  return {
    adapter: 'node',
    address: { host: address.address, port: address.port, family: address.family },
    url: `http://${displayHost}:${address.port}`,
    fetch: dispatch,
    close,
  }
}

function toRequest(incoming: IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers()
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index]
    const value = incoming.rawHeaders[index + 1]
    if (name && value !== undefined) headers.append(name, value)
  }

  const method = (incoming.method ?? 'GET').toUpperCase()
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(incoming) as BodyInit
    init.duplex = 'half'
  }
  return new Request(`http://${incoming.headers.host ?? 'localhost'}${incoming.url ?? '/'}`, init)
}

async function sendResponse(outgoing: ServerResponse, response: Response, head = false): Promise<void> {
  try {
    await writeResponse(outgoing, response, head)
  } catch (error) {
    // Pipeline owns locked bodies; cancel bodies rejected before it acquired them.
    if (response.body && !response.body.locked) {
      try { await response.body.cancel(error) } catch {}
    }
    throw error
  }
}

async function writeResponse(outgoing: ServerResponse, response: Response, head: boolean): Promise<void> {
  if (outgoing.destroyed || head) {
    await response.body?.cancel()
    if (outgoing.destroyed) return
  }
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

  if (!response.body || head) {
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
