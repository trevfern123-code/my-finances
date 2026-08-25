import type { Request, Response, NextFunction } from 'express';
import * as dataService from '../services/dataService';

const THEME_IDS = ['system', 'light', 'dark'];
const ACCENT_IDS = ['green', 'blue', 'teal', 'indigo', 'purple', 'amber'];

export async function getUserPreferences(req: Request, res: Response, next: NextFunction) {
  try {
    const prefs = await dataService.getUserPreferences(req.user!.id);
    res.json({
      dashboard_layout: prefs?.dashboard_layout ?? null,
      theme: prefs?.theme ?? 'system',
      accent_color: prefs?.accent_color ?? 'green',
    });
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

interface AppearanceBody {
  theme?: string;
  accent_color?: string;
}

export async function updateAppearance(req: Request, res: Response, next: NextFunction) {
  try {
    const { theme, accent_color: accentColor } = req.body as AppearanceBody;

    if (typeof theme !== 'string' || !THEME_IDS.includes(theme)) {
      res.status(400).json({ error: `theme must be one of: ${THEME_IDS.join(', ')}` });
      return;
    }
    if (typeof accentColor !== 'string' || !ACCENT_IDS.includes(accentColor)) {
      res.status(400).json({ error: `accent_color must be one of: ${ACCENT_IDS.join(', ')}` });
      return;
    }

    const prefs = await dataService.upsertAppearance(req.user!.id, { theme, accentColor });
    res.json({ theme: prefs.theme, accent_color: prefs.accent_color });
  } catch (err) {
    next(err);
  }
}
