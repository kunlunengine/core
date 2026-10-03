/** Portable Runtime M3 contracts, separate from Core's legacy application manifest. */
export interface RuntimeCapabilityDeclaration {
  name: 'fs.binding' | 'http.host'
  resource: string
}

export interface RuntimeCapabilityRequirements {
  required: readonly RuntimeCapabilityDeclaration[]
  optional: readonly RuntimeCapabilityDeclaration[]
}

export interface RuntimeArtifactFile {
  url: string
  kind: 'module' | 'asset' | 'source_map'
  sha256: string
  for?: string
}

export interface RuntimeArtifactManifest {
  schema: 'kunlun.runtime-manifest/v1'
  engine: { abi: 1; runtime_profile: 'kunlun-m2-web/1' }
  entry_contract: 'kunlun.fetch-entry/v1'
  entry: string
  files: readonly RuntimeArtifactFile[]
  required_features: readonly string[]
  compatibility_flags: readonly string[]
  capabilities: RuntimeCapabilityRequirements
}

export interface RuntimeFileBinding {
  readTextFile(path: string): Promise<string>
}

export interface RuntimeHttpBinding {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

/** Host-created request authority. No caller credentials or host paths are projected. */
export interface RuntimeRequestEnvironment {
  readonly fs: Readonly<Record<string, RuntimeFileBinding>>
  readonly http: Readonly<Record<string, RuntimeHttpBinding>>
}

export interface RuntimeExecutionContext {
  readonly signal: AbortSignal
  /** Explicitly unsupported by the current Node slice; calls throw. */
  waitUntil(promise: Promise<unknown>): void
}

export type RuntimeFetchEntry = (
  request: Request,
  env: RuntimeRequestEnvironment,
  context: RuntimeExecutionContext,
) => Response | Promise<Response>
