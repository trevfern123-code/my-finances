import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import * as budgetCategoryController from '../controllers/budgetCategoryController';

export const budgetCategoriesRouter = Router();

budgetCategoriesRouter.use(requireAuth);

budgetCategoriesRouter.get('/', budgetCategoryController.listBudgetCategories);
budgetCategoriesRouter.post('/', budgetCategoryController.createBudgetCategory);
budgetCategoriesRouter.patch('/:id', budgetCategoryController.updateBudgetCategory);
budgetCategoriesRouter.delete('/:id', budgetCategoryController.deleteBudgetCategory);
