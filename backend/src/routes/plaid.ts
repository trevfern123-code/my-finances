import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import * as plaidController from '../controllers/plaidController';

export const plaidRouter = Router();

plaidRouter.use(requireAuth);

plaidRouter.post('/link-token', plaidController.createLinkToken);
plaidRouter.post('/exchange-public-token', plaidController.exchangePublicToken);
plaidRouter.get('/items', plaidController.listLinkedItems);
plaidRouter.get('/summary', plaidController.getSpendingSummary);
plaidRouter.get('/net-worth-history', plaidController.getNetWorthHistory);
plaidRouter.get('/monthly-breakdown', plaidController.getMonthlyBreakdown);
plaidRouter.get('/recurring-streams', plaidController.getRecurringStreams);
plaidRouter.get('/loans', plaidController.getLoans);
plaidRouter.get('/assets-summary', plaidController.getAssetsSummary);
plaidRouter.post('/accounts/refresh', plaidController.refreshAccounts);
plaidRouter.patch('/accounts/:accountId/credit-limit', plaidController.updateAccountCreditLimit);
plaidRouter.post('/transactions/sync', plaidController.syncTransactions);
plaidRouter.get('/transactions', plaidController.listTransactions);
plaidRouter.patch('/transactions/:transactionId/category', plaidController.setTransactionCategory);
plaidRouter.post('/items/:itemId/reauth-link-token', plaidController.createReauthLinkToken);
plaidRouter.post('/items/:itemId/reauth-complete', plaidController.completeReauth);
plaidRouter.post('/items/:itemId/sandbox-reset-login', plaidController.sandboxResetLogin);
plaidRouter.post('/items/:itemId/sandbox-fire-webhook', plaidController.sandboxFireWebhook);
