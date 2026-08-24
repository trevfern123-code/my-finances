import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import * as manualLoanController from '../controllers/manualLoanController';

export const manualLoansRouter = Router();

manualLoansRouter.use(requireAuth);

manualLoansRouter.get('/', manualLoanController.listManualLoans);
manualLoansRouter.post('/', manualLoanController.createManualLoan);
manualLoansRouter.patch('/:id', manualLoanController.updateManualLoan);
manualLoansRouter.delete('/:id', manualLoanController.deleteManualLoan);

manualLoansRouter.get('/:id/payments', manualLoanController.listLinkedPayments);
manualLoansRouter.patch('/:id/payments/:transactionId', manualLoanController.updateLinkedPayment);
manualLoansRouter.delete('/:id/payments/:transactionId', manualLoanController.unlinkPayment);
