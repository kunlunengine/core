export type GeneratorBuilder = 'nasti' | 'vite' | 'webpack' | 'rspack'

export interface GeneratorFile {
  /** Portable, project-relative path using forward slashes. */
  readonly path: string
  readonly contents: string
}

export interface GeneratorDependencies {
  readonly dependencies: Readonly<Record<string, string>>
  readonly devDependencies: Readonly<Record<string, string>>
}

export interface GeneratorProject {
  readonly name: string
  readonly builder: GeneratorBuilder
  readonly packageManager: string
}

export interface GeneratorCommand {
  readonly cwd: string
  readonly command: string
  readonly args: readonly string[]
}

export interface GeneratorIdentity {
  readonly protocol: 'kunlun.generator/v1'
  readonly template: string
  readonly version: string
}

/** Source-preview protocol; custom/remote template loading is not supported yet. */
export interface GeneratorTemplate {
  readonly identity: GeneratorIdentity
  generate(project: GeneratorProject): {
    readonly files: readonly GeneratorFile[]
    readonly dependencies: GeneratorDependencies
  }
}

export interface GeneratorPlan {
  readonly schema: 'kunlun.generator-plan/v1'
  readonly generator: GeneratorIdentity
  readonly destination: string
  readonly project: GeneratorProject
  readonly files: readonly GeneratorFile[]
  readonly dependencies: GeneratorDependencies
  readonly nextCommands: readonly GeneratorCommand[]
}

export type GeneratorDiagnosticCode =
  | 'KUNLUN_CREATE_ARGUMENT_INVALID'
  | 'KUNLUN_CREATE_BUILDER_UNKNOWN'
  | 'KUNLUN_CREATE_DESTINATION_INVALID'
  | 'KUNLUN_CREATE_DESTINATION_NOT_EMPTY'
  | 'KUNLUN_CREATE_TEMPLATE_INVALID'
  | 'KUNLUN_CREATE_WRITE_FAILED'

export interface GeneratorDiagnostic {
  readonly schema: 'kunlun.generator-diagnostic/v1'
  readonly code: GeneratorDiagnosticCode
  readonly message: string
  readonly remediation: string
}

export class GeneratorError extends Error {
  readonly diagnostic: GeneratorDiagnostic

  constructor(code: GeneratorDiagnosticCode, message: string, remediation: string) {
    super(message)
    this.name = 'GeneratorError'
    this.diagnostic = { schema: 'kunlun.generator-diagnostic/v1', code, message, remediation }
  }
}
