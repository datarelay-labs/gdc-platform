import { describe, expect, it } from 'vitest'
import { AUTH_SERVICE_UNAVAILABLE_MESSAGE, userFacingLoginError } from './login-error'

describe('userFacingLoginError', () => {
  it('keeps invalid-credentials JSON semantics (400 USER_AUTH_FAILED)', () => {
    expect(
      userFacingLoginError(new Error('400: [USER_AUTH_FAILED] Invalid username or password.')),
    ).toBe('400: [USER_AUTH_FAILED] Invalid username or password.')
  })

  it('keeps 401 and 403 authentication messages', () => {
    expect(userFacingLoginError(new Error('401: Unauthorized'))).toBe('401: Unauthorized')
    expect(userFacingLoginError(new Error('403: Forbidden'))).toBe('403: Forbidden')
  })

  it('sanitizes nginx 502 HTML', () => {
    const html =
      '502: <html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx/1.27.5</center>\r\n</body>\r\n</html>'
    expect(userFacingLoginError(new Error(html))).toBe(AUTH_SERVICE_UNAVAILABLE_MESSAGE)
  })

  it('sanitizes 5xx without exposing gateway bodies', () => {
    expect(userFacingLoginError(new Error('502: Request failed'))).toBe(AUTH_SERVICE_UNAVAILABLE_MESSAGE)
    expect(userFacingLoginError(new Error('503: [NON_JSON_RESPONSE] upstream'))).toBe(
      AUTH_SERVICE_UNAVAILABLE_MESSAGE,
    )
  })

  it('sanitizes network failures', () => {
    expect(userFacingLoginError(new Error('Failed to fetch'))).toBe(AUTH_SERVICE_UNAVAILABLE_MESSAGE)
    expect(userFacingLoginError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(
      AUTH_SERVICE_UNAVAILABLE_MESSAGE,
    )
  })
})
