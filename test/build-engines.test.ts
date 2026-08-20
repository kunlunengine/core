import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BuildEngine } from '@kunlun-js/build-api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nasti } from '../packages/builder-nasti/src/index.js'
import { rspack } from '../packages/builder-rspack/src/index.js'
import { vite } from '../packages/builder-vite/src/index.js'
import { webpack } from '../packages/builder-webpack/src/index.js'

let root: string

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kunlun-build-engines-'))
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src/main.js'), "export const greeting = 'hello kunlun'\n")
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><div id="app"></div><script type="module" src="/src/main.js"></script>\n',
  )
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe.sequential('build engine contract', () => {
  const engines: Array<[string, () => BuildEngine]> = [
    ['nasti', nasti],
    ['vite', vite],
    ['webpack', webpack],
    ['rspack', rspack],
  ]

  it.each(engines)('%s performs a production build through the common API', async (name, create) => {
    const engine = create()
    const session = await engine.createSession({ root, mode: 'production' })
    try {
      const result = await session.build({
        name: 'client',
        consumer: 'client',
        entries: { main: './src/main.js' },
        outDir: `dist/${name}`,
        sourcemap: true,
        minify: false,
      })
      expect(result.engine).toBe(name)
      expect(result.artifacts.length).toBeGreaterThan(0)
      expect(result.diagnostics.filter((item) => item.level === 'error')).toEqual([])
    } finally {
      await session.close()
    }
  })

  it.each(engines)('%s starts and closes a development session', async (name, create) => {
    const engine = create()
    const session = await engine.createSession({ root, mode: 'development' })
    let dev: Awaited<ReturnType<typeof session.serve>> | undefined
    try {
      dev = await session.serve({
        name: 'client',
        consumer: 'client',
        entries: { main: './src/main.js' },
        outDir: `dist/${name}-dev`,
        port: 0,
      })
      expect(dev.engine).toBe(name)
      expect(dev.urls[0]).toMatch(/^http:\/\//)
      expect(dev.middleware).toBeTypeOf('function')
    } finally {
      await dev?.close()
      await session.close()
    }
  })

  it('reports capabilities instead of pretending every engine is identical', () => {
    expect(nasti().capabilities.multiEnvironment).toBe('native')
    expect(vite().capabilities.hmr).toBe(true)
    expect(webpack().capabilities.hmr).toBe(false)
    expect(rspack().capabilities.multiEnvironment).toBe('orchestrated')
  })
})
