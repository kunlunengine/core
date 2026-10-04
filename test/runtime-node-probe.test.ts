import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRequestAuthority } from '../packages/runtime-node/src/authority.js'
import { executeAuthorityProbe, validateAuthorityObservations } from '../scripts/authority-probe.mjs'

describe('Node authority probe collection', () => {
  it('executes real reads in one realm with two independently revoked request scopes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kunlun-probe-test-'))
    await mkdir(path.join(root, 'public'))
    await writeFile(path.join(root, 'public/message.txt'), 'public message')
    await writeFile(path.join(root, 'escape.txt'), 'private message')
    const authority = await createRequestAuthority({
      required: [{ name: 'fs.binding', resource: 'public-data' }],
      optional: [],
    }, { fs: { 'public-data': path.join(root, 'public') } })
    try {
      const source = `
        const text = await env.fs['public-data'].readTextFile('message.txt');
        let stale = null;
        if (globalThis.previousRequestHandle) {
          try { await globalThis.previousRequestHandle.readTextFile('message.txt'); stale = false; }
          catch { stale = true; }
        }
        globalThis.previousRequestHandle = env.fs['public-data'];
        return JSON.stringify({ text, stale });
      `
      const observations = await executeAuthorityProbe(authority, source, path.join(root, 'escape.txt'))
      const expected = [
        { text: 'public message', stale: null },
        { text: 'public message', stale: true },
      ]
      expect(observations).toEqual(expected)
      expect(() => validateAuthorityObservations(observations, expected)).not.toThrow()
      await expect(executeAuthorityProbe(authority, 'return { text: "not JSON" };', '/escape.txt'))
        .rejects.toThrow('JSON string')
    } finally {
      await authority.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects normalization, missing or extra keys, reordered requests and missing evidence', () => {
    const expected = [{ denied: true, stale: null }, { denied: true, stale: true }]
    for (const observations of [
      [{ denied: 1, stale: null }, expected[1]],
      [{ denied: true }, expected[1]],
      [{ denied: true, stale: null, extra: true }, expected[1]],
      [expected[1], expected[0]],
      [expected[0]],
      [],
    ]) {
      expect(() => validateAuthorityObservations(observations, expected)).toThrow('shared contract')
    }
  })
})
