// Reads linked-transaction rows (JSON array of {id, amount, category,
// personal_finance_category_detailed, personal_finance_category_confidence}) on stdin and prints
// the delete_manual_loan_atomic p_reclassify payload the application itself would send, using the
// real compiled classifier (backend/dist) — so concurrency tests exercise production classification,
// not a SQL re-implementation of it. Run `npm --prefix backend run build` first (run.sh does).
const path = require('node:path');

const { buildLoanDeletionReclassifyPayload } = require(
  path.join(__dirname, '..', '..', '..', 'backend', 'dist', 'services', 'loanDeletionReclassify.js')
);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const rows = JSON.parse(input);
  process.stdout.write(JSON.stringify(buildLoanDeletionReclassifyPayload(rows)));
});
