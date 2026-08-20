import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../packages/cli/src/run.js'

describe('kunlun CLI', () => {
  it('scaffolds the selected build engine even when options precede the destination', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'kunlun-cli-'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await runCli(['new', '--builder', 'vite', 'hello'], parent)
      const packageJson = JSON.parse(await readFile(path.join(parent, 'hello/package.json'), 'utf8'))
      const config = await readFile(path.join(parent, 'hello/kunlun.config.mjs'), 'utf8')
      expect(packageJson.dependencies['@kunlun-js/builder-vite']).toBe('^0.1.0')
      expect(packageJson.devDependencies.vite).toBe('^8.2.2')
      expect(config).toContain("import { vite } from '@kunlun-js/builder-vite'")
      expect(config).toContain('builder: vite()')
    } finally {
      log.mockRestore()
      await rm(parent, { recursive: true, force: true })
    }
  })
})
