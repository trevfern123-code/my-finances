import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { plaidRouter } from './routes/plaid';
import { budgetCategoriesRouter } from './routes/budgetCategories';
import { errorHandler } from './middleware/errorHandler';

// Last-resort logging so a future unhandled rejection is visible in deploy logs before
// the process exits, rather than the container just going silently unresponsive.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: env.frontendUrl,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json());
app.use(morgan('dev'));

app.get('/', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/plaid', plaidRouter);
app.use('/api/budget-categories', budgetCategoriesRouter);

app.use(errorHandler);

// Binding explicitly to 0.0.0.0 (rather than the implicit default) is required in some
// container networking setups — Railway's healthcheck couldn't reach the app without it.
app.listen(env.port, '0.0.0.0', () => {
  console.log(`Backend listening on 0.0.0.0:${env.port}`);
});
