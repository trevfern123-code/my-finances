import type { Request, Response, NextFunction } from 'express';
import * as dataService from '../services/dataService';
import {
  aggregateSpendByCategory,
  getCurrentMonthRange,
  getRecentMonthsRange,
} from '../services/budgetPeriod';
import type { BudgetCategoryWithSpend } from '../types';

const RECENT_AVG_MONTHS = 2;

export async function listBudgetCategories(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const currentRange = getCurrentMonthRange();
    const recentRange = getRecentMonthsRange(RECENT_AVG_MONTHS);

    const [categories, currentSpendRows, recentSpendRows] = await Promise.all([
      dataService.listBudgetCategories(userId),
      dataService.getCategorySpendRows(userId, currentRange),
      dataService.getCategorySpendRows(userId, recentRange),
    ]);

    const currentSpendByCategory = aggregateSpendByCategory(currentSpendRows);
    const recentSpendByCategory = aggregateSpendByCategory(recentSpendRows);

    const categoriesWithSpend: BudgetCategoryWithSpend[] = categories.map((category) => ({
      ...category,
      spent: currentSpendByCategory.get(category.id) ?? 0,
      recent_avg_spent: (recentSpendByCategory.get(category.id) ?? 0) / RECENT_AVG_MONTHS,
    }));

    res.json({ categories: categoriesWithSpend });
  } catch (err) {
    next(err);
  }
}

export async function createBudgetCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, budget_amount: budgetAmount, color, sort_order: sortOrder, emoji } = req.body as {
      name?: string;
      budget_amount?: number;
      color?: string | null;
      sort_order?: number;
      emoji?: string | null;
    };

    if (!name || typeof budgetAmount !== 'number') {
      res.status(400).json({ error: 'name and budget_amount are required' });
      return;
    }

    const category = await dataService.createBudgetCategory(req.user!.id, {
      name,
      budgetAmount,
      color: color ?? null,
      sortOrder: sortOrder ?? 0,
      emoji: emoji ?? null,
    });
    res.status(201).json({ category });
  } catch (err) {
    next(err);
  }
}

export async function updateBudgetCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const {
      name,
      budget_amount: budgetAmount,
      color,
      sort_order: sortOrder,
      emoji,
      archived,
    } = req.body as {
      name?: string;
      budget_amount?: number;
      color?: string | null;
      sort_order?: number;
      emoji?: string | null;
      /** Action-oriented rather than a client-supplied timestamp, since this app already treats
       *  client clock skew as untrustworthy (see the JWT clock-skew mitigation elsewhere) — the
       *  actual archived_at value is always set server-side from `now()`. */
      archived?: boolean;
    };

    const fields: Record<string, unknown> = {};
    if (name !== undefined) fields.name = name;
    if (budgetAmount !== undefined) fields.budget_amount = budgetAmount;
    if (color !== undefined) fields.color = color;
    if (sortOrder !== undefined) fields.sort_order = sortOrder;
    if (emoji !== undefined) fields.emoji = emoji;
    if (archived !== undefined) fields.archived_at = archived ? new Date().toISOString() : null;

    const category = await dataService.updateBudgetCategory(id, userId, fields);
    if (!category) {
      res.status(404).json({ error: 'Budget category not found' });
      return;
    }

    // Archiving stops the category from receiving new auto-categorized transactions going
    // forward — any existing mapping that targets it no longer serves a purpose and would
    // silently keep routing new spend into an "archived" category, so it's removed here. This
    // never touches transactions/splits that already reference the category historically.
    let removedMappingIds: string[] | undefined;
    if (archived === true) {
      removedMappingIds = await dataService.deleteCategoryMappingsForBudgetCategory(id, userId);
    }

    res.json({ category, ...(removedMappingIds && removedMappingIds.length > 0 ? { removed_mapping_ids: removedMappingIds } : {}) });
  } catch (err) {
    next(err);
  }
}

export async function deleteBudgetCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    await dataService.deleteBudgetCategory(id, req.user!.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
