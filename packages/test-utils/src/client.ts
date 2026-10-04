export type TestRequest = string | URL | Request

export interface TestClient {
  url(path?: string): string
  fetch(input: TestRequest, init?: RequestInit): Promise<Response>
  $fetch<T = unknown>(input: TestRequest, init?: RequestInit): Promise<T>
}

export class TestFetchError extends Error {
  readonly response: Response
  readonly data: unknown

  constructor(response: Response, data: unknown) {
    super(`Test request failed: ${response.status} ${response.statusText}`.trim())
    this.name = 'TestFetchError'
    this.response = response
    this.data = data
  }
}

export function createTestClient(
  baseURL: string,
  dispatch: (request: Request) => Promise<Response>,
): TestClient {
  const base = new URL(baseURL)
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TypeError('Test client baseURL must use HTTP or HTTPS')
  }
  const url = (path = '') => new URL(path, base).href
  const fetch = async (input: TestRequest, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : url(String(input)), init)
    return dispatch(request)
  }

  return {
    url,
    fetch,
    async $fetch<T = unknown>(input: TestRequest, init?: RequestInit): Promise<T> {
      const response = await fetch(input, init)
      // Preserve the raw response on errors so callers can inspect headers and body.
      const body = await response.clone().text()
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      const isJSON = contentType === 'application/json' || contentType?.endsWith('+json')
      let data: unknown = body === '' ? undefined : body
      if (body !== '' && isJSON) {
        try {
          data = JSON.parse(body)
        } catch (error) {
          if (response.ok) throw error
          // A malformed error payload must not hide the HTTP failure.
        }
      }
      if (!response.ok) throw new TestFetchError(response, data)
      return data as T
    },
  }
}
