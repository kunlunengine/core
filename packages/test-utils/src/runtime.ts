import {
  createRuntimeApplication,
  defineApplication,
  type ApplicationDefinition,
  type RequestHandlerOptions,
  type RuntimeApplication,
} from '@kunlun-js/core'
import { createTestClient, type TestClient } from './client.js'

export { TestFetchError, type TestClient, type TestRequest } from './client.js'

export interface TestApplicationOptions extends RequestHandlerOptions {
  baseURL?: string
}

export interface TestApplication extends TestClient {
  readonly application: RuntimeApplication
}

export function createTestApplication(
  definition: ApplicationDefinition,
  options: TestApplicationOptions = {},
): TestApplication {
  const application = createRuntimeApplication(defineApplication(definition), options)
  const client = createTestClient(options.baseURL ?? 'http://kunlun.test/', (request) => application.fetch(request))
  return { application, ...client }
}
