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
      minimum_cash_buffer: prefs?.minimum_cash_buffer ?? 0,
      upcoming_bills_days: prefs?.upcoming_bills_days ?? 14,
      recent_avg_months: prefs?.recent_avg_months ?? 2,
      savings_rate_target: prefs?.savings_rate_target ?? 15,
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

interface FinancialPreferencesBody {
  minimum_cash_buffer?: number;
  upcoming_bills_days?: number;
  recent_avg_months?: number;
  savings_rate_target?: number;
}

export async function updateFinancialPreferences(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      minimum_cash_buffer: minimumCashBuffer,
      upcoming_bills_days: upcomingBillsDays,
      recent_avg_months: recentAvgMonths,
      savings_rate_target: savingsRateTarget,
    } = req.body as FinancialPreferencesBody;

    if (typeof minimumCashBuffer !== 'number' || !Number.isFinite(minimumCashBuffer) || minimumCashBuffer < 0) {
      res.status(400).json({ error: 'minimum_cash_buffer must be a non-negative number' });
      return;
    }
    if (
      typeof upcomingBillsDays !== 'number' ||
      !Number.isInteger(upcomingBillsDays) ||
      upcomingBillsDays < 1 ||
      upcomingBillsDays > 90
    ) {
      res.status(400).json({ error: 'upcoming_bills_days must be an integer between 1 and 90' });
      return;
    }
    if (
      typeof recentAvgMonths !== 'number' ||
      !Number.isInteger(recentAvgMonths) ||
      recentAvgMonths < 1 ||
      recentAvgMonths > 12
    ) {
      res.status(400).json({ error: 'recent_avg_months must be an integer between 1 and 12' });
      return;
    }
    if (
      typeof savingsRateTarget !== 'number' ||
      !Number.isFinite(savingsRateTarget) ||
      savingsRateTarget < 0 ||
      savingsRateTarget > 100
    ) {
      res.status(400).json({ error: 'savings_rate_target must be a number between 0 and 100' });
      return;
    }

    const prefs = await dataService.upsertFinancialPreferences(req.user!.id, {
      minimumCashBuffer,
      upcomingBillsDays,
      recentAvgMonths,
      savingsRateTarget,
    });
    res.json({
      minimum_cash_buffer: prefs.minimum_cash_buffer,
      upcoming_bills_days: prefs.upcoming_bills_days,
      recent_avg_months: prefs.recent_avg_months,
      savings_rate_target: prefs.savings_rate_target,
    });
  } catch (err) {
    next(err);
  }
}
