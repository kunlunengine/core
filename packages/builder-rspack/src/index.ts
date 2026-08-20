import { createServer, type Server } from 'node:http'
import path from 'node:path'
import type { Compiler, Configuration, Stats } from '@rspack/core'
import {
  BuildEngineError,
  errorMessage,
  type BuildArtifact,
  type BuildDiagnostic,
  type BuildEngine,
  type BuildRequest,
  type BuildSession,
  type ServeRequest,
} from '@kunlun-js/build-api'

type RspackFactory = (config: Configuration) => Compiler
type RspackDevMiddleware = typeof import('@rspack/dev-middleware')['devMiddleware']

export interface RspackBuilderOptions {
  config?: Configuration
  implementation?: RspackFactory
  devMiddleware?: RspackDevMiddleware
}

export function rspack(options: RspackBuilderOptions = {}): BuildEngine {
  return {
    name: 'rspack',
    displayName: 'Rspack',
    capabilities: Object.freeze({
      hmr: false,
      middleware: true,
      moduleGraph: false,
      multiEnvironment: 'orchestrated',
      ssrModuleRunner: false,
      lazyCompilation: false,
    }),
    async createSession(context): Promise<BuildSession> {
      const factory = options.implementation ?? (await import('@rspack/core')).rspack
      const active = new Set<() => Promise<void>>()

      return {
        async build(request) {
          const compiler = factory(createRspackConfig(context.root, context.mode, request, options.config))
          const start = performance.now()
          try {
            const stats = await runCompiler(compiler)
            return normalizeStats(stats, request, performance.now() - start)
          } finally {
            await closeCompiler(compiler)
          }
        },
        async serve(request) {
          const compiler = factory(createRspackConfig(context.root, context.mode, request, options.config))
          const devMiddleware = options.devMiddleware
            ?? (await import('@rspack/dev-middleware')).devMiddleware
          const middleware = devMiddleware(compiler, {
            publicPath: options.config?.output?.publicPath ?? '/',
          })
          const server = createMiddlewareServer(middleware)
          const host = request.host ?? '127.0.0.1'
          const port = await listen(server, request.port ?? 0, host)
          let closed = false
          const close = async () => {
            if (closed) return
            closed = true
            active.delete(close)
            await closeServer(server)
            await new Promise<void>((resolve, reject) => {
              middleware.close((error?: Error | null) => error ? reject(error) : resolve())
            })
            await closeCompiler(compiler)
          }
          active.add(close)

          return {
            engine: 'rspack',
            target: request.name,
            urls: [`http://${displayHost(host)}:${port}/`],
            middleware: middleware as never,
            invalidate: async () => new Promise<void>((resolve) => middleware.invalidate(() => resolve())),
            close,
          }
        },
        async close() {
          await Promise.all([...active].map((close) => close()))
        },
      }
    },
  }
}

function createRspackConfig(
  root: string,
  mode: 'development' | 'production',
  request: BuildRequest | ServeRequest,
  base: Configuration = {},
): Configuration {
  const configuredExternals = base.externals === undefined
    ? []
    : Array.isArray(base.externals) ? base.externals : [base.externals]
  const config: Configuration = {
    ...base,
    context: root,
    mode,
    target: base.target ?? (request.consumer === 'client' ? 'web' : 'node'),
    entry: request.entries,
    output: {
      ...base.output,
      path: path.resolve(root, request.outDir),
      clean: base.output?.clean ?? true,
      filename: base.output?.filename ?? '[name].js',
    },
    optimization: {
      ...base.optimization,
      ...(request.minify === undefined ? {} : { minimize: request.minify }),
    },
    externals: [
      ...configuredExternals,
      /^kunlun:/,
      ...(request.external ?? []),
    ] as NonNullable<Configuration['externals']>,
  }
  if (request.sourcemap !== undefined) config.devtool = request.sourcemap ? 'source-map' : false
  return config
}

function runCompiler(compiler: Compiler): Promise<Stats> {
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      if (error) reject(error)
      else if (!stats) reject(new Error('Rspack completed without stats'))
      else resolve(stats)
    })
  })
}

function normalizeStats(stats: Stats, request: BuildRequest, durationMs: number) {
  const data = stats.toJson({ all: false, assets: true, entrypoints: true, errors: true, warnings: true })
  const diagnostics: BuildDiagnostic[] = [
    ...(data.warnings ?? []).map((warning) => ({ level: 'warning' as const, message: diagnosticMessage(warning) })),
    ...(data.errors ?? []).map((error) => ({ level: 'error' as const, message: diagnosticMessage(error) })),
  ]
  if (stats.hasErrors()) throw new BuildEngineError('rspack', 'Rspack build failed', diagnostics)

  const artifacts: BuildArtifact[] = (data.assets ?? []).flatMap((asset) => {
    if (!asset.name) return []
    return [{ type: 'asset' as const, fileName: asset.name, ...(asset.size === undefined ? {} : { bytes: asset.size }) }]
  })
  const entries = normalizeEntrypoints(data.entrypoints as unknown)
  const entryFiles = new Set(Object.values(entries))
  for (const artifact of artifacts) if (entryFiles.has(artifact.fileName)) artifact.entry = true

  return {
    engine: 'rspack',
    target: request.name,
    outDir: request.outDir,
    durationMs,
    artifacts,
    entries,
    diagnostics,
    raw: stats,
  }
}

function normalizeEntrypoints(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(Object.entries(value).flatMap(([name, entry]) => {
    if (!entry || typeof entry !== 'object') return []
    const assets = (entry as { assets?: Array<string | { name?: string }> }).assets ?? []
    const first = assets.map((asset) => typeof asset === 'string' ? asset : asset.name).find(Boolean)
    return first ? [[name, first]] : []
  }))
}

function diagnosticMessage(value: unknown): string {
  if (value && typeof value === 'object' && 'message' in value) return errorMessage(value.message)
  return errorMessage(value)
}

function createMiddlewareServer(middleware: ReturnType<RspackDevMiddleware>): Server {
  return createServer((request, response) => {
    middleware(request, response, (error) => {
      response.statusCode = error ? 500 : 404
      response.end(error ? errorMessage(error) : 'Not Found')
    })
  })
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : port)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()))
}

function closeCompiler(compiler: Compiler): Promise<void> {
  return new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve()))
}

function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? 'localhost' : host
}
