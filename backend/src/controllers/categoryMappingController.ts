import type { Request, Response, NextFunction } from 'express';
import * as dataService from '../services/dataService';

export async function listCategoryMappings(req: Request, res: Response, next: NextFunction) {
  try {
    const mappings = await dataService.listCategoryMappings(req.user!.id);
    res.json({ mappings });
  } catch (err) {
    next(err);
  }
}

export async function listPlaidCategories(req: Request, res: Response, next: NextFunction) {
  try {
    const categories = await dataService.listDistinctPlaidCategoriesForUser(req.user!.id);
    res.json({ categories });
  } catch (err) {
    next(err);
  }
}

export async function upsertCategoryMapping(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const {
      plaid_category: plaidCategory,
      budget_category_id: budgetCategoryId,
      backfill,
    } = req.body as {
      plaid_category?: string;
      budget_category_id?: string;
      backfill?: boolean;
    };

    if (!plaidCategory || !budgetCategoryId) {
      res.status(400).json({ error: 'plaid_category and budget_category_id are required' });
      return;
    }

    const ownsCategory = await dataService.budgetCategoryBelongsToUser(budgetCategoryId, userId);
    if (!ownsCategory) {
      res.status(404).json({ error: 'Budget category not found' });
      return;
    }

    const mapping = await dataService.upsertCategoryMapping(userId, plaidCategory, budgetCategoryId);
    const backfilledCount = backfill
      ? await dataService.backfillCategoryMapping(userId, plaidCategory, budgetCategoryId)
      : 0;

    res.status(201).json({ mapping, backfilled_count: backfilledCount });
  } catch (err) {
    next(err);
  }
}

export async function deleteCategoryMapping(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    await dataService.deleteCategoryMapping(id, req.user!.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
