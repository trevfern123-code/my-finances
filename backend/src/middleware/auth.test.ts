import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { requireAuth } from './auth';

// vi.hoisted ensures mockGetUser exists before vi.mock's factory runs — vi.mock itself is
// hoisted above the `import { requireAuth } from './auth'` above, which transitively imports
// '../config/supabase'.
const mockGetUser = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({
  supabaseAdmin: { auth: { getUser: mockGetUser } },
}));

function mockReqRes(authHeader?: string) {
  const req = { headers: { authorization: authHeader } } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

/** A JWT-shaped string carrying `claims`. Unsigned: Supabase (mocked here) is what verifies tokens. */
function unsignedJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

beforeEach(() => {
  mockGetUser.mockReset();
});

describe('requireAuth', () => {
  it('rejects a missing Authorization header with 401 and does not call next', async () => {
    const { req, res, next } = mockReqRes(undefined);
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('rejects a header without the Bearer prefix', async () => {
    const { req, res, next } = mockReqRes('sometoken');
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches req.user and calls next() on a valid token', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'a@b.com' } }, error: null });
    const { req, res, next } = mockReqRes('Bearer valid-token');

    await requireAuth(req, res, next);

    // Not a decodable JWT (Supabase is mocked), so there is no session to bind to.
    expect(req.user).toEqual({ id: 'user-1', email: 'a@b.com', sessionId: null });
    expect(next).toHaveBeenCalledWith(); // called with no error
    expect(res.status).not.toHaveBeenCalled();
  });

  it('attaches the verified token\'s session_id claim as req.user.sessionId', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'a@b.com' } }, error: null });
    const { req, res, next } = mockReqRes(`Bearer ${unsignedJwt({ sub: 'user-1', session_id: 'sid-1' })}`);

    await requireAuth(req, res, next);

    expect(req.user).toEqual({ id: 'user-1', email: 'a@b.com', sessionId: 'sid-1' });
    expect(next).toHaveBeenCalledWith();
  });

  it('a blank or non-string session_id is treated as no session', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: null } }, error: null });
    for (const sessionId of ['  ', 42]) {
      const { req, res, next } = mockReqRes(`Bearer ${unsignedJwt({ sub: 'user-1', session_id: sessionId })}`);
      await requireAuth(req, res, next);
      expect(req.user?.sessionId).toBeNull();
    }
  });

  it('refuses (401) a token whose sub is not the user Supabase verified', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: null } }, error: null });
    const { req, res, next } = mockReqRes(`Bearer ${unsignedJwt({ sub: 'user-2', session_id: 'sid-2' })}`);

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(req.user).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Supabase reports an invalid/expired session', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });
    const { req, res, next } = mockReqRes('Bearer expired-token');

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a thrown error to next(err) instead of crashing the process', async () => {
    // Regression test: requireAuth used to have no try/catch, so a rejected promise here
    // (e.g. Supabase network failure) became an unhandled rejection and crashed the whole
    // backend on every authenticated request — this is what took production down.
    const networkError = new Error('network blip reaching Supabase');
    mockGetUser.mockRejectedValue(networkError);
    const { req, res, next } = mockReqRes('Bearer some-token');

    await expect(requireAuth(req, res, next)).resolves.toBeUndefined();

    expect(next).toHaveBeenCalledWith(networkError);
    expect(res.status).not.toHaveBeenCalled();
  });
});
