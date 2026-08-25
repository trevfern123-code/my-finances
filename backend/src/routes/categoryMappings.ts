import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import * as categoryMappingController from '../controllers/categoryMappingController';

export const categoryMappingsRouter = Router();

categoryMappingsRouter.use(requireAuth);

categoryMappingsRouter.get('/', categoryMappingController.listCategoryMappings);
categoryMappingsRouter.get('/plaid-categories', categoryMappingController.listPlaidCategories);
categoryMappingsRouter.post('/', categoryMappingController.upsertCategoryMapping);
categoryMappingsRouter.delete('/:id', categoryMappingController.deleteCategoryMapping);
