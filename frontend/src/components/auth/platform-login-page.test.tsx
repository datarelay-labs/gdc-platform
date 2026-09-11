import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearSession, readSession } from '../../auth/session'
import { PlatformLoginPage } from './platform-login-page'

describe('PlatformLoginPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    clearSession()
  })

  it('stores must_change_password and advances to the password-change gate after bootstrap login', async () => {
    const onAuthenticated = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            user: {
              username: 'admin',
              role: 'ADMINISTRATOR',
              status: 'ACTIVE',
              must_change_password: true,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    render(<PlatformLoginPage onAuthenticated={onAuthenticated} />)

    await userEvent.type(screen.getByLabelText('Username'), 'admin')
    await userEvent.type(screen.getByLabelText('Password'), 'admin')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1))
    expect(readSession()?.user.must_change_password).toBe(true)
  })

  it('shows a sanitized service-unavailable message instead of nginx HTML on 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx/1.27.5</center>\r\n</body>\r\n</html>\r\n',
            { status: 502, headers: { 'Content-Type': 'text/html' } },
          ),
      ),
    )

    render(<PlatformLoginPage onAuthenticated={vi.fn()} />)

    await userEvent.type(screen.getByLabelText('Username'), 'admin')
    await userEvent.type(screen.getByLabelText('Password'), 'admin')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Authentication service is temporarily unavailable. Please try again.',
    )
    expect(screen.queryByText(/nginx/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/<!DOCTYPE/i)).not.toBeInTheDocument()
  })

  it('keeps the existing invalid-credentials message on 400 USER_AUTH_FAILED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              detail: { error_code: 'USER_AUTH_FAILED', message: 'Invalid username or password.' },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )

    render(<PlatformLoginPage onAuthenticated={vi.fn()} />)

    await userEvent.type(screen.getByLabelText('Username'), 'admin')
    await userEvent.type(screen.getByLabelText('Password'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password.')
    expect(screen.queryByText(/temporarily unavailable/i)).not.toBeInTheDocument()
  })

  it('shows a sanitized message on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    render(<PlatformLoginPage onAuthenticated={vi.fn()} />)

    await userEvent.type(screen.getByLabelText('Username'), 'admin')
    await userEvent.type(screen.getByLabelText('Password'), 'admin')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Authentication service is temporarily unavailable. Please try again.',
    )
  })
})
