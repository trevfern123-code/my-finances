import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import * as cardPaymentRecoveryController from '../controllers/cardPaymentRecoveryController';

/**
 * Guarded manual recovery (I3A-R packet 2-A). Every route is behind requireAuth; the owner of every request is
 * the verified session's user. The claim and refresh functions of the worker have NO route: they are called by
 * the server's own worker only (workers/cardPaymentRecoveryWorker.ts).
 */
export const cardPaymentRecoveryRouter = Router();

cardPaymentRecoveryRouter.use(requireAuth);

cardPaymentRecoveryRouter.get('/reviews', cardPaymentRecoveryController.getReviews);
cardPaymentRecoveryRouter.post('/actions', cardPaymentRecoveryController.postAction);
cardPaymentRecoveryRouter.get('/actions/:operationId', cardPaymentRecoveryController.getAction);
cardPaymentRecoveryRouter.post('/refresh-retries', cardPaymentRecoveryController.postRefreshRetry);
