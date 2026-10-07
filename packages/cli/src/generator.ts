import { lstat, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { GeneratorError, type GeneratorBuilder, type GeneratorFile, type GeneratorPlan } from './generator-types.js'
import { clientFetchTemplate } from './template.js'

export interface CreateProjectOptions {
  readonly destination: string
  readonly builder?: string
  readonly cwd?: string
}

/** Read-only planning: no config imports, subprocesses, network, or writes. */
export async function planProjectCreation(options: CreateProjectOptions): Promise<GeneratorPlan> {
  const builder = options.builder ?? 'nasti'
  if (!isBuilder(builder)) {
    throw new GeneratorError(
      'KUNLUN_CREATE_BUILDER_UNKNOWN',
      `Unknown build engine: ${builder}`,
      'Choose nasti, vite, webpack, or rspack with --builder.',
    )
  }
  if (!options.destination.trim() || options.destination.includes('\0')) {
    throw invalidDestination(options.destination, 'The destination must be a non-empty directory path.')
  }
  const destination = path.resolve(options.cwd ?? process.cwd(), options.destination)
  if (destination === path.parse(destination).root) {
    throw invalidDestination(destination, 'The filesystem root cannot be a project destination.')
  }
  await validateDestination(destination)
  const name = path.basename(destination).replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || name.length > 214 || ['node_modules', 'favicon.ico'].includes(name)) {
    throw invalidDestination(destination, 'The directory name cannot form a valid package name.')
  }
  const project = { name, builder, packageManager: 'pnpm@11.22.0' }
  const output = clientFetchTemplate.generate(project)
  return {
    schema: 'kunlun.generator-plan/v1',
    generator: { ...clientFetchTemplate.identity },
    destination,
    project,
    files: normalizeFiles(output.files),
    dependencies: output.dependencies,
    nextCommands: [
      { cwd: destination, command: 'pnpm', args: ['install'] },
      { cwd: destination, command: 'pnpm', args: ['dev'] },
    ],
  }
}

/** Internal executor for the first-party plan, not an arbitrary template/plugin API. */
export async function materializeProject(plan: GeneratorPlan): Promise<void> {
  const files = normalizeFiles(plan.files)
  // A plan is not a reservation: check again immediately before the first write.
  await validateDestination(plan.destination)
  try {
    await mkdir(plan.destination, { recursive: true })
    await validateDestination(plan.destination)
    const directories = new Set<string>()
    for (const file of files) {
      let directory = path.posix.dirname(file.path)
      while (directory !== '.') {
        directories.add(directory)
        directory = path.posix.dirname(directory)
      }
    }
    for (const directory of [...directories].sort()) {
      await mkdir(path.join(plan.destination, directory))
    }
    for (const file of files) {
      await writeFile(path.join(plan.destination, file.path), file.contents, { encoding: 'utf8', flag: 'wx' })
    }
  } catch (error) {
    if (error instanceof GeneratorError) throw error
    throw new GeneratorError(
      'KUNLUN_CREATE_WRITE_FAILED',
      `Could not write the project at ${plan.destination}: ${errorMessage(error)}`,
      'Inspect any partially created files and permissions, then retry with an empty destination. Existing files are not overwritten.',
    )
  }
}

function isBuilder(value: string): value is GeneratorBuilder {
  return ['nasti', 'vite', 'webpack', 'rspack'].includes(value)
}

async function validateDestination(destination: string): Promise<void> {
  try {
    const entry = await lstat(destination).catch((error: unknown) => {
      if (hasCode(error, 'ENOENT')) return undefined
      throw error
    })
    if (entry) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw invalidDestination(destination, 'The destination must be a directory, not a file or symbolic link.')
      }
      if ((await readdir(destination)).length > 0) {
        throw new GeneratorError(
          'KUNLUN_CREATE_DESTINATION_NOT_EMPTY',
          `Directory is not empty: ${destination}`,
          'Choose a new or empty directory; Kunlun does not merge into existing projects.',
        )
      }
      return
    }
    // Missing nested parents are valid, but an existing ancestor must be a directory.
    // stat deliberately permits ordinary symlinked parents (e.g. /tmp on macOS).
    let parent = path.dirname(destination)
    while (true) {
      try {
        const ancestor = await stat(parent)
        if (!ancestor.isDirectory()) throw invalidDestination(destination, `Parent is not a directory: ${parent}`)
        return
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error
        // A dangling ancestor symlink is not a missing directory we can create.
        const ancestor = await lstat(parent).catch((error: unknown) => {
          if (hasCode(error, 'ENOENT')) return undefined
          throw error
        })
        if (ancestor) throw invalidDestination(destination, `Parent is a dangling symbolic link: ${parent}`)
        const next = path.dirname(parent)
        if (next === parent) throw invalidDestination(destination, 'No existing parent directory was found.')
        parent = next
      }
    }
  } catch (error) {
    if (error instanceof GeneratorError) throw error
    throw invalidDestination(destination, errorMessage(error))
  }
}

function normalizeFiles(files: readonly GeneratorFile[]): GeneratorFile[] {
  const seen = new Set<string>()
  for (const file of files) {
    const segments = file.path.split('/')
    if (!file.path || /[\\:\0]/.test(file.path) || segments.some((part) => !part || part === '.' || part === '..')
      || seen.has(file.path.toLowerCase())) {
      throw new GeneratorError(
        'KUNLUN_CREATE_TEMPLATE_INVALID',
        `Invalid or colliding template file path: ${file.path}`,
        'Report this first-party template error to the Kunlun maintainers.',
      )
    }
    seen.add(file.path.toLowerCase())
  }
  for (const file of files) {
    let parent = path.posix.dirname(file.path)
    while (parent !== '.') {
      if (seen.has(parent.toLowerCase())) {
        throw new GeneratorError(
          'KUNLUN_CREATE_TEMPLATE_INVALID',
          `Template file conflicts with a directory: ${parent}`,
          'Report this first-party template error to the Kunlun maintainers.',
        )
      }
      parent = path.posix.dirname(parent)
    }
  }
  return [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

function invalidDestination(destination: string, reason: string): GeneratorError {
  return new GeneratorError(
    'KUNLUN_CREATE_DESTINATION_INVALID',
    `Invalid destination ${JSON.stringify(destination)}: ${reason}`,
    'Choose an accessible directory path with a package-compatible name (for example, hello-kunlun).',
  )
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
