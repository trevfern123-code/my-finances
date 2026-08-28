import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { plaidRouter } from './routes/plaid';
import { budgetCategoriesRouter } from './routes/budgetCategories';
import { categoryMappingsRouter } from './routes/categoryMappings';
import { manualLoansRouter } from './routes/manualLoans';
import { userPreferencesRouter } from './routes/userPreferences';
import { webhooksRouter } from './routes/webhooks';
import { errorHandler } from './middleware/errorHandler';
import { validateKeyRingOrExit } from './services/tokenEncryption';

// Last-resort logging so a future unhandled rejection is visible in deploy logs before
// the process exits, rather than the container just going silently unresponsive.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

// Fail closed *before* the app ever binds a port or serves traffic if Plaid access-token
// encryption is misconfigured (PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md §5.5) — the alternative
// (validating lazily, on first use) would let /health return 200 while every real Plaid request
// silently breaks the moment it's tried. Also populates getKeyRing()'s cache here, so every
// request handler that calls it afterward reuses this same validated, in-memory key ring rather
// than re-reading the environment.
validateKeyRingOrExit();

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: env.frontendUrl,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(
  express.json({
    // Plaid webhook signatures are computed over the exact raw request bytes — capture them
    // alongside normal JSON parsing rather than re-reading the (already-consumed) stream later.
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = buf;
    },
  })
);
app.use(morgan('dev'));

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

// Binding explicitly to 0.0.0.0 (rather than the implicit default) is required in some
// container networking setups — Railway's healthcheck couldn't reach the app without it.
app.listen(env.port, '0.0.0.0', () => {
  console.log(`Backend listening on 0.0.0.0:${env.port}`);
});
