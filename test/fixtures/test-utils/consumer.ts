import { describe, expect, it } from '@lightning-js/lightning'
import { route } from '@kunlun-js/core'
import { createTestApplication, createTestServer } from '@kunlun-js/test-utils'
import { createTestApplication as runtimeApplication } from '@kunlun-js/test-utils/runtime'
import { setup } from '@kunlun-js/test-utils/e2e'

const application = {
  name: 'packed-test',
  services: [{ name: 'api', routes: [route('GET', '/', () => Response.json({ packed: true }))] }],
}

describe('packed exports', () => {
  const context = setup({ application })

  it('uses the suite-scoped HTTP server', async () => {
    await expect(context.$fetch('/')).resolves.toEqual({ packed: true })
  })

  it('uses runner-neutral runtime and root exports', async () => {
    await expect(createTestApplication(application).$fetch('/')).resolves.toEqual({ packed: true })
    await expect(runtimeApplication(application).$fetch('/')).resolves.toEqual({ packed: true })
    const server = await createTestServer({ application })
    try {
      await expect(server.$fetch('/')).resolves.toEqual({ packed: true })
    } finally {
      await server.close()
    }
  })
})
