import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import * as manualLoanController from '../controllers/manualLoanController';

export const manualLoansRouter = Router();

manualLoansRouter.use(requireAuth);

manualLoansRouter.get('/', manualLoanController.listManualLoans);
// Two create routes during the transition (Round 16): the idempotent one the current frontend uses,
// and the legacy one kept for cached pre-Round-16 bundles. See manualLoanController.ts.
manualLoansRouter.post('/idempotent', manualLoanController.createManualLoanIdempotent);
manualLoansRouter.post('/', manualLoanController.createManualLoanLegacy);
manualLoansRouter.patch('/:id', manualLoanController.updateManualLoan);
manualLoansRouter.delete('/:id', manualLoanController.deleteManualLoan);

manualLoansRouter.get('/:id/payments', manualLoanController.listPayments);
manualLoansRouter.patch('/:id/payments/:transactionId', manualLoanController.updateLinkedPayment);
manualLoansRouter.delete('/:id/payments/:transactionId', manualLoanController.unlinkPayment);

manualLoansRouter.post('/:id/manual-payments', manualLoanController.createManualPayment);
manualLoansRouter.patch('/:id/manual-payments/:paymentId', manualLoanController.updateManualPayment);
manualLoansRouter.delete('/:id/manual-payments/:paymentId', manualLoanController.deleteManualPayment);
