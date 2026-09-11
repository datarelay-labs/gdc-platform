import { describe, expect, it } from 'vitest'
import { parseResponseBody } from './api'

describe('parseResponseBody', () => {
  it('does not expose raw nginx HTML in the parsed error message', () => {
    const html =
      '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx/1.27.5</center>\r\n</body>\r\n</html>\r\n'
    const body = parseResponseBody(html) as { error_code: string; message: string }
    expect(body.error_code).toBe('NON_JSON_RESPONSE')
    expect(body.message).toBe('The service returned a non-JSON error response.')
    expect(body.message).not.toMatch(/nginx/i)
    expect(body.message).not.toMatch(/<html/i)
  })

  it('parses JSON bodies unchanged', () => {
    const body = parseResponseBody(
      JSON.stringify({ detail: { error_code: 'USER_AUTH_FAILED', message: 'Invalid username or password.' } }),
    ) as { detail: { error_code: string } }
    expect(body.detail.error_code).toBe('USER_AUTH_FAILED')
  })
})
