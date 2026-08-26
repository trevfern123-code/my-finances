import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import * as userPreferencesController from '../controllers/userPreferencesController';

export const userPreferencesRouter = Router();

userPreferencesRouter.use(requireAuth);

userPreferencesRouter.get('/', userPreferencesController.getUserPreferences);
userPreferencesRouter.put('/dashboard-layout', userPreferencesController.updateDashboardLayout);
userPreferencesRouter.put('/appearance', userPreferencesController.updateAppearance);
userPreferencesRouter.put('/financial', userPreferencesController.updateFinancialPreferences);
userPreferencesRouter.put('/reporting-range', userPreferencesController.updateReportingRange);
