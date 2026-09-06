import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { getUserPreferences, updateNavLayout } from './userPreferencesController';

const mockGetUserPreferences = vi.hoisted(() => vi.fn());
const mockUpsertNavLayout = vi.hoisted(() => vi.fn());
vi.mock('../services/dataService', () => ({
  getUserPreferences: mockGetUserPreferences,
  upsertNavLayout: mockUpsertNavLayout,
}));

function fakeReq(body: unknown = {}): Request {
  return { user: { id: 'user-1' }, body } as unknown as Request;
}

function fakeRes(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
}

const next = vi.fn() as unknown as NextFunction;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getUserPreferences — nav_layout in the response', () => {
  it('returns null nav_layout for a user who has never customized navigation', async () => {
    mockGetUserPreferences.mockResolvedValue(null);
    const res = fakeRes();

    await getUserPreferences(fakeReq(), res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ nav_layout: null }));
  });

  it('passes through a saved nav_layout unchanged', async () => {
    const navLayout = { tabs: [{ id: 'loans', visible: false }] };
    mockGetUserPreferences.mockResolvedValue({ nav_layout: navLayout });
    const res = fakeRes();

    await getUserPreferences(fakeReq(), res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ nav_layout: navLayout }));
  });
});

describe('updateNavLayout — validation', () => {
  it('rejects a body where tabs is not an array', async () => {
    const res = fakeRes();

    await updateNavLayout(fakeReq({ tabs: 'not-an-array' }), res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockUpsertNavLayout).not.toHaveBeenCalled();
  });

  it('rejects an entry with a non-string id', async () => {
    const res = fakeRes();

    await updateNavLayout(fakeReq({ tabs: [{ id: 42, visible: true }] }), res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockUpsertNavLayout).not.toHaveBeenCalled();
  });

  it('rejects an entry with a non-boolean visible', async () => {
    const res = fakeRes();

    await updateNavLayout(fakeReq({ tabs: [{ id: 'loans', visible: 'yes' }] }), res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockUpsertNavLayout).not.toHaveBeenCalled();
  });

  it('accepts a well-formed tabs array and persists it', async () => {
    const tabs = [{ id: 'loans', visible: false }];
    mockUpsertNavLayout.mockResolvedValue({ nav_layout: { tabs } });
    const res = fakeRes();

    await updateNavLayout(fakeReq({ tabs }), res, next);

    expect(mockUpsertNavLayout).toHaveBeenCalledWith('user-1', { tabs });
    expect(res.json).toHaveBeenCalledWith({ nav_layout: { tabs } });
  });

  it('accepts an empty tabs array', async () => {
    mockUpsertNavLayout.mockResolvedValue({ nav_layout: { tabs: [] } });
    const res = fakeRes();

    await updateNavLayout(fakeReq({ tabs: [] }), res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(mockUpsertNavLayout).toHaveBeenCalledWith('user-1', { tabs: [] });
  });

  it('forwards a persistence failure to next(), not a response', async () => {
    mockUpsertNavLayout.mockRejectedValue(new Error('db down'));
    const res = fakeRes();

    await updateNavLayout(fakeReq({ tabs: [{ id: 'loans', visible: true }] }), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
