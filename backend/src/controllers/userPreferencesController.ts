import type { Request, Response, NextFunction } from 'express';
import * as dataService from '../services/dataService';

export async function getUserPreferences(req: Request, res: Response, next: NextFunction) {
  try {
    const prefs = await dataService.getUserPreferences(req.user!.id);
    res.json({ dashboard_layout: prefs?.dashboard_layout ?? null });
  } catch (err) {
    next(err);
  }
}

interface DashboardLayoutBody {
  cards?: { id?: string; visible?: boolean }[];
}

export async function updateDashboardLayout(req: Request, res: Response, next: NextFunction) {
  try {
    const { cards } = req.body as DashboardLayoutBody;

    if (!Array.isArray(cards) || cards.some((c) => typeof c.id !== 'string' || typeof c.visible !== 'boolean')) {
      res.status(400).json({ error: 'cards must be an array of { id: string, visible: boolean }' });
      return;
    }

    const dashboardLayout = { cards: cards as { id: string; visible: boolean }[] };
    const prefs = await dataService.upsertDashboardLayout(req.user!.id, dashboardLayout);
    res.json({ dashboard_layout: prefs.dashboard_layout });
  } catch (err) {
    next(err);
  }
}
