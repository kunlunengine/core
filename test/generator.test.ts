import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from '@lightning-js/lightning'
import { materializeProject, planProjectCreation } from '../packages/cli/src/generator.js'
import { GeneratorError, type GeneratorPlan } from '../packages/cli/src/generator-types.js'
import { runCli } from '../packages/cli/src/run.js'

async function withDirectory(test: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kunlun-generator-'))
  try {
    await test(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function diagnostic(code: string) {
  return { diagnostic: { schema: 'kunlun.generator-diagnostic/v1', code, remediation: expect.any(String) } }
}

describe('creation plans', () => {
  it('matches a normalized versioned fixture without creating missing parents', async () => {
    await withDirectory(async (cwd) => {
      const plan = await planProjectCreation({ destination: 'missing/hello', cwd })
      const again = await planProjectCreation({ destination: './missing/../missing/hello', cwd })
      const fixture = JSON.parse(await readFile(new URL('./fixtures/cli/generator-plan.json', import.meta.url), 'utf8'))
      const normalized = {
        ...plan,
        destination: '<DESTINATION>',
        nextCommands: plan.nextCommands.map((command) => ({ ...command, cwd: '<DESTINATION>' })),
      }
      expect(normalized).toEqual(fixture)
      expect(again).toEqual(plan)
      expect(await readdir(cwd)).toEqual([])
    })
  })

  it.each(['nasti', 'vite', 'webpack', 'rspack'])('plans and writes the same bytes for %s', async (builder) => {
    await withDirectory(async (cwd) => {
      const plan = await planProjectCreation({ destination: 'nested/hello', builder, cwd })
      const manifestFile = plan.files.find((file) => file.path === 'package.json')!
      const manifest = JSON.parse(manifestFile.contents)
      expect(manifest.dependencies).toEqual(plan.dependencies.dependencies)
      expect(manifest.devDependencies).toEqual(plan.dependencies.devDependencies)
      expect(manifest.packageManager).toBe(plan.project.packageManager)
      const adapter = JSON.parse(await readFile(new URL(`../packages/builder-${builder}/package.json`, import.meta.url), 'utf8'))
      for (const peer of Object.keys(adapter.peerDependencies)) {
        expect(manifest.devDependencies[peer]).toEqual(expect.any(String))
      }
      expect(plan.files.find((file) => file.path === 'kunlun.config.mjs')!.contents).toContain(`builder: ${builder}()`)
      await materializeProject(plan)
      for (const file of plan.files) {
        expect(await readFile(path.join(plan.destination, file.path), 'utf8')).toBe(file.contents)
      }
      expect((await readdir(plan.destination)).sort()).toEqual(['.gitignore', 'index.html', 'kunlun.config.mjs', 'package.json', 'src'])
    })
  })

  it('allows an existing empty destination without changing it during planning', async () => {
    await withDirectory(async (cwd) => {
      const destination = path.join(cwd, 'hello')
      await mkdir(destination)
      const plan = await planProjectCreation({ destination, cwd })
      expect(await readdir(destination)).toEqual([])
      await materializeProject(plan)
      expect(await access(path.join(destination, 'package.json'))).toBeUndefined()
    })
  })

  it.each(['constructor', '__proto__', 'toString', 'other', ''])('rejects unknown builder %s before writes', async (builder) => {
    await withDirectory(async (cwd) => {
      await expect(planProjectCreation({ destination: 'hello', builder, cwd }))
        .rejects.toMatchObject(diagnostic('KUNLUN_CREATE_BUILDER_UNKNOWN'))
      expect(await readdir(cwd)).toEqual([])
    })
  })

  it.each(['', ' ', 'bad\0path', '.hidden', 'node_modules', 'favicon.ico', '---'])(
    'rejects invalid destination %s before writes',
    async (destination) => {
      await withDirectory(async (cwd) => {
        await expect(planProjectCreation({ destination, cwd }))
          .rejects.toMatchObject(diagnostic('KUNLUN_CREATE_DESTINATION_INVALID'))
        expect(await readdir(cwd)).toEqual([])
      })
    },
  )

  it('rejects non-empty directories, files and invalid ancestors without modifying them', async () => {
    await withDirectory(async (cwd) => {
      await mkdir(path.join(cwd, 'hello'))
      await writeFile(path.join(cwd, 'hello/.keep'), 'preserve')
      await writeFile(path.join(cwd, 'file'), 'preserve')
      await expect(planProjectCreation({ destination: 'hello', cwd }))
        .rejects.toMatchObject(diagnostic('KUNLUN_CREATE_DESTINATION_NOT_EMPTY'))
      for (const destination of ['file', 'file/missing/hello']) {
        await expect(planProjectCreation({ destination, cwd }))
          .rejects.toMatchObject(diagnostic('KUNLUN_CREATE_DESTINATION_INVALID'))
      }
      expect(await readFile(path.join(cwd, 'hello/.keep'), 'utf8')).toBe('preserve')
      expect(await readFile(path.join(cwd, 'file'), 'utf8')).toBe('preserve')
      expect(await readdir(path.join(cwd, 'hello'))).toEqual(['.keep'])
    })
  })

  it('rejects symlink destinations and dangling parents, while allowing normal linked parents', async () => {
    await withDirectory(async (cwd) => {
      await mkdir(path.join(cwd, 'actual'))
      await symlink(path.join(cwd, 'actual'), path.join(cwd, 'linked'), 'junction')
      await symlink(path.join(cwd, 'missing'), path.join(cwd, 'dangling'), 'junction')
      for (const destination of ['linked', 'dangling', 'dangling/nested/hello']) {
        await expect(planProjectCreation({ destination, cwd }))
          .rejects.toMatchObject(diagnostic('KUNLUN_CREATE_DESTINATION_INVALID'))
      }
      const plan = await planProjectCreation({ destination: 'linked/hello', cwd })
      expect(await readdir(path.join(cwd, 'actual'))).toEqual([])
      await materializeProject(plan)
      expect(await readFile(path.join(cwd, 'actual/hello/.gitignore'), 'utf8')).toBe('node_modules/\ndist/\n.kunlun/\n')
    })
  })

  it('revalidates stale plans before the first write', async () => {
    await withDirectory(async (cwd) => {
      const plan = await planProjectCreation({ destination: 'hello', cwd })
      await mkdir(plan.destination)
      await writeFile(path.join(plan.destination, 'user.txt'), 'preserve')
      await expect(materializeProject(plan))
        .rejects.toMatchObject(diagnostic('KUNLUN_CREATE_DESTINATION_NOT_EMPTY'))
      expect(await readdir(plan.destination)).toEqual(['user.txt'])
      expect(await readFile(path.join(plan.destination, 'user.txt'), 'utf8')).toBe('preserve')
    })
  })

  it.each([
    ['../outside.js'],
    ['/absolute.js'],
    ['src\\escape.js'],
    ['a.js', 'A.js'],
    ['src', 'src/main.js'],
  ])('rejects invalid or colliding plan files %s before writing', async (...paths) => {
    await withDirectory(async (cwd) => {
      const plan = await planProjectCreation({ destination: 'hello', cwd })
      const invalid = { ...plan, files: paths.map((filePath) => ({ path: filePath, contents: 'unsafe' })) }
      await expect(materializeProject(invalid))
        .rejects.toMatchObject(diagnostic('KUNLUN_CREATE_TEMPLATE_INVALID'))
      expect(await readdir(cwd)).toEqual([])
    })
  })
})

describe('creation CLI', () => {
  it('emits equivalent JSON for create/new and real execution', async () => {
    await withDirectory(async (cwd) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      try {
        await runCli(['create', '--dry-run', '--builder=vite', '--json', 'hello'], cwd)
        const preview = JSON.parse(log.mock.calls[0]![0] as string) as GeneratorPlan
        expect(log.mock.calls).toHaveLength(1)
        log.mockClear()
        await runCli(['new', 'hello', '--builder', 'vite', '--json', '--dry-run'], cwd)
        expect(log.mock.calls).toEqual([[JSON.stringify(preview)]])
        expect(await readdir(cwd)).toEqual([])
        log.mockClear()
        await runCli(['create', '--builder=vite', '--json', 'hello'], cwd)
        expect(log.mock.calls).toEqual([[JSON.stringify(preview)]])
        for (const file of preview.files) {
          expect(await readFile(path.join(preview.destination, file.path), 'utf8')).toBe(file.contents)
        }
      } finally {
        log.mockRestore()
      }
    })
  })

  it('renders human dry runs from the same plan without importing project config', async () => {
    await withDirectory(async (cwd) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      await writeFile(path.join(cwd, 'kunlun.config.mjs'), 'throw new Error("Must not import config")')
      try {
        const plan = await planProjectCreation({ destination: 'hello', cwd })
        await runCli(['new', '--dry-run', '--', 'hello'], cwd)
        for (const file of plan.files) expect(log).toHaveBeenCalledWith(`  write ${file.path}`)
        expect(log).toHaveBeenCalledWith('  Dry run: no files written or commands executed.')
        expect(await readdir(cwd)).toEqual(['kunlun.config.mjs'])
      } finally {
        log.mockRestore()
      }
    })
  })

  it.each([
    [],
    ['hello', 'extra'],
    ['hello', '--unknown'],
    ['hello', '--builder'],
    ['hello', '--builder', '--json'],
    ['hello', '--dry-run=false'],
    ['hello', '--json=true'],
    ['--help', '--json'],
  ])('rejects malformed creation arguments %s with a diagnostic', async (...args) => {
    await withDirectory(async (cwd) => {
      await expect(runCli(['create', ...args], cwd)).rejects.toMatchObject(diagnostic('KUNLUN_CREATE_ARGUMENT_INVALID'))
      expect(await readdir(cwd)).toEqual([])
    })
  })

  it.each(['build', 'dev', 'start', 'doctor', 'engines'])(
    'rejects unimplemented machine flags on %s instead of executing it',
    async (command) => {
      await withDirectory(async (cwd) => {
        await expect(runCli([command, '--dry-run'], cwd)).rejects.toThrow('supported only')
        await expect(runCli([command, '--', '--dry-run'], cwd)).rejects.toThrow('supported only')
        await expect(runCli([command, '--json'], cwd)).rejects.toThrow('supported only')
        expect(await readdir(cwd)).toEqual([])
      })
    },
  )

  it('exports structured errors without changing library callers into process exits', async () => {
    await withDirectory(async (cwd) => {
      try {
        await planProjectCreation({ destination: 'hello', builder: 'bad', cwd })
        throw new Error('Expected a generator error')
      } catch (error) {
        expect(error).toBeInstanceOf(GeneratorError)
        expect((error as GeneratorError).diagnostic.code).toBe('KUNLUN_CREATE_BUILDER_UNKNOWN')
      }
    })
  })
})
