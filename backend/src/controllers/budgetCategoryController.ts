import type { Request, Response, NextFunction } from 'express';
import * as dataService from '../services/dataService';
import { aggregateSpendByCategory, getCurrentMonthRange } from '../services/budgetPeriod';
import type { BudgetCategoryWithSpend } from '../types';

export async function listBudgetCategories(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const range = getCurrentMonthRange();

    const [categories, spendRows] = await Promise.all([
      dataService.listBudgetCategories(userId),
      dataService.getCategorySpendRows(userId, range),
    ]);

    const spendByCategory = aggregateSpendByCategory(spendRows);
    const categoriesWithSpend: BudgetCategoryWithSpend[] = categories.map((category) => ({
      ...category,
      spent: spendByCategory.get(category.id) ?? 0,
    }));

    res.json({ categories: categoriesWithSpend });
  } catch (err) {
    next(err);
  }
}

export async function createBudgetCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, budget_amount: budgetAmount, color, sort_order: sortOrder } = req.body as {
      name?: string;
      budget_amount?: number;
      color?: string | null;
      sort_order?: number;
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
    });
    res.status(201).json({ category });
  } catch (err) {
    next(err);
  }
}

export async function updateBudgetCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const { name, budget_amount: budgetAmount, color, sort_order: sortOrder } = req.body as {
      name?: string;
      budget_amount?: number;
      color?: string | null;
      sort_order?: number;
    };

    const fields: Record<string, unknown> = {};
    if (name !== undefined) fields.name = name;
    if (budgetAmount !== undefined) fields.budget_amount = budgetAmount;
    if (color !== undefined) fields.color = color;
    if (sortOrder !== undefined) fields.sort_order = sortOrder;

    const category = await dataService.updateBudgetCategory(id, req.user!.id, fields);
    if (!category) {
      res.status(404).json({ error: 'Budget category not found' });
      return;
    }

    res.json({ category });
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
