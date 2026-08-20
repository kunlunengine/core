import type { IncomingMessage, ServerResponse } from 'node:http'

export type BuildConsumer = 'client' | 'server' | 'extension'
export type MultiEnvironmentSupport = false | 'orchestrated' | 'native'

export interface BuildCapabilities {
  hmr: boolean
  middleware: boolean
  moduleGraph: boolean
  multiEnvironment: MultiEnvironmentSupport
  ssrModuleRunner: boolean
  lazyCompilation: boolean
}

export interface ApplicationManifest {
  name: string
  version?: string
  services: Array<{
    name: string
    capabilities: Array<{
      name: string
      optional: boolean
      operations: string[]
    }>
    routes: Array<{ method: string; path: string }>
  }>
}

export interface BuildContext {
  root: string
  mode: 'development' | 'production'
  application?: ApplicationManifest
}

export interface BuildRequest {
  name: string
  consumer: BuildConsumer
  entries: Record<string, string>
  outDir: string
  sourcemap?: boolean
  minify?: boolean
  external?: Array<string | RegExp>
}

export interface ServeRequest extends BuildRequest {
  host?: string
  port?: number
}

export interface BuildArtifact {
  type: 'chunk' | 'asset'
  fileName: string
  bytes?: number
  entry?: boolean
}

export interface BuildDiagnostic {
  level: 'warning' | 'error'
  message: string
  file?: string
}

export interface BuildResult {
  engine: string
  target: string
  outDir: string
  durationMs: number
  artifacts: BuildArtifact[]
  entries: Record<string, string>
  diagnostics: BuildDiagnostic[]
  raw?: unknown
}

export type BuildMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => unknown

export interface DevSession {
  engine: string
  target: string
  urls: string[]
  middleware?: BuildMiddleware
  transform?: (url: string) => Promise<{ code: string; map?: unknown } | null>
  loadServerModule?: (url: string) => Promise<Record<string, unknown>>
  invalidate?: (files: string[]) => Promise<void>
  close(): Promise<void>
}

export interface BuildSession {
  build(request: BuildRequest): Promise<BuildResult>
  serve(request: ServeRequest): Promise<DevSession>
  close(): Promise<void>
}

export interface BuildEngine {
  readonly name: string
  readonly displayName: string
  readonly capabilities: Readonly<BuildCapabilities>
  createSession(context: BuildContext): Promise<BuildSession>
}

export class BuildEngineError extends Error {
  readonly engine: string
  readonly diagnostics: BuildDiagnostic[]

  constructor(engine: string, message: string, diagnostics: BuildDiagnostic[] = []) {
    super(message)
    this.name = 'BuildEngineError'
    this.engine = engine
    this.diagnostics = diagnostics
  }
}

export function artifactBytes(source: unknown): number | undefined {
  if (typeof source === 'string') return Buffer.byteLength(source)
  if (source instanceof Uint8Array) return source.byteLength
  return undefined
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
