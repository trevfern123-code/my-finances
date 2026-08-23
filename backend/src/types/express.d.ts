import type { AuthenticatedUser } from './index';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      /** Captured by express.json()'s verify callback — needed to check Plaid's webhook signature. */
      rawBody?: Buffer;
    }
  }
}

export {};
