import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { plaidRouter } from './routes/plaid';
import { budgetCategoriesRouter } from './routes/budgetCategories';
import { errorHandler } from './middleware/errorHandler';

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
