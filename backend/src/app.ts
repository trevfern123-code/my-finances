import express from 'express';
import cors, { type CorsOptions } from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { plaidRouter } from './routes/plaid';
import { budgetCategoriesRouter } from './routes/budgetCategories';
import { categoryMappingsRouter } from './routes/categoryMappings';
import { manualLoansRouter } from './routes/manualLoans';
import { userPreferencesRouter } from './routes/userPreferences';
import { webhooksRouter } from './routes/webhooks';
import { errorHandler } from './middleware/errorHandler';

/**
 * The CORS policy for browser calls from the frontend. `Idempotency-Key` must be listed because the
 * frontend runs on a different origin from this API (Vercel vs Railway in production, port 5173 vs
 * 4000 locally), so any custom request header triggers a preflight. Without it here the browser
 * never sends the manual-loan create at all (Round 16 remediation — the Round 8–15 idempotency
 * work was unreachable from a real browser because this list only had Content-Type and
 * Authorization).
 */
export function buildCorsOptions(frontendUrl: string): CorsOptions {
  return {
    origin: frontendUrl,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  };
}

/**
 * Builds the complete Express app — every middleware and route, in production order — without
 * binding a port, so tests can exercise the real configuration. index.ts adds startup checks and
 * listen().
 */
export function createApp(options: { frontendUrl: string; logRequests?: boolean }): express.Express {
  const app = express();

  app.use(helmet());
  app.use(cors(buildCorsOptions(options.frontendUrl)));
  app.use(
    express.json({
      // Plaid webhook signatures are computed over the exact raw request bytes — capture them
      // alongside normal JSON parsing rather than re-reading the (already-consumed) stream later.
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    })
  );
  if (options.logRequests !== false) app.use(morgan('dev'));

  app.get('/', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/plaid', plaidRouter);
  app.use('/api/budget-categories', budgetCategoriesRouter);
  app.use('/api/category-mappings', categoryMappingsRouter);
  app.use('/api/manual-loans', manualLoansRouter);
  app.use('/api/user-preferences', userPreferencesRouter);
  app.use('/api/webhooks', webhooksRouter);

  app.use(errorHandler);

  return app;
}
