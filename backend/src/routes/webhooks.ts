import { Router } from 'express';
import { handlePlaidWebhook } from '../controllers/webhookController';

// Not behind requireAuth — Plaid calls this directly as a server, not as a signed-in user.
// Authenticity is verified via the Plaid-Verification JWT instead (see webhookVerification.ts).
export const webhooksRouter = Router();

webhooksRouter.post('/plaid', handlePlaidWebhook);
