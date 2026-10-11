import { describe, expect, it } from 'vitest';
import { KNOWN_UNRESOLVED_REASONS, readRecoveryAnswer, readRecoveryLookup, readRecoveryReviews, readSummarySemantics } from './semanticModel';
import { relinkReviewCount, reviewReadingText } from './semanticPresentation';
import { summaryWire, unresolvedCashFlowWire } from '../testUtils/semanticFixtures';

// The recovery responses as this build reads them (I3A-R packet 2-A): exactly the documented shape, or `invalid`.
// A reading this build does not know is never turned into a figure, a range or a zero.

const K = '22222222-2222-4222-8222-222222222222';
const W = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const OBLIGATION = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';

const freshness = (over: Record<string, unknown> = {}) => ({
  fresh: true,
  input_version: 7,
  evaluated_version: 7,
  review_revision: 3,
  last_error_code: null,
  refresh: { queued: false, needs_attention: false, attempts: 0 },
  ...over,
});
const candidate = (over: Record<string, unknown> = {}) => ({
  transaction_id: W,
  account_id: ACCOUNT,
  date: '2026-09-11',
  amount_cents: -37000,
  pending: false,
  account_included: true,
  kind: 'tier1_competitor',
  distance_days: 1,
  difference_cents: 0,
  withheld_by_guard: true,
  suggestion_only: true,
  rejected: false,
  ...over,
});
const obligation = (over: Record<string, unknown> = {}) => ({
  obligation_id: OBLIGATION,
  origin: 'captured',
  completeness: 'complete',
  gap_reason: null,
  removal_id: D,
  institution_name: 'Card Bank',
  removed_on: '2026-10-01',
  known_surviving_edge_count: 1,
  sources: [{ evidence_kind: 'ambiguity_hold', decision_id: D, decision_kind: 'ambiguity_hold_removed_card', decision_status: 'active', source_relation: 'removed_candidate', source_date: '2026-09-11', source_cents: -37000, source_known: true }],
  ...over,
});
const review = (over: Record<string, unknown> = {}) => ({
  transaction_id: K,
  account_id: ACCOUNT,
  date: '2026-09-10',
  amount_cents: 37000,
  pending: false,
  side: 'cash',
  direction: 'payment',
  account_included: true,
  state: 'unresolved',
  reason: 'relink_review_required',
  detail: null,
  effect_cents: null,
  low_cents: -37000,
  high_cents: 0,
  partner_transaction_id: null,
  guard_withheld: true,
  withheld_partner_transaction_id: W,
  coverage_gap: false,
  deferred: false,
  controlling_decision: null,
  obligations: [obligation()],
  candidates: [candidate()],
  ...over,
});
const body = (over: Record<string, unknown> = {}) => ({ fresh: true, freshness: freshness(), actions_enabled: true, affected_payment_count: 1, next_cursor: null, reviews: [review()], ...over });
const receipt = (over: Record<string, unknown> = {}) => ({
  operation_id: D,
  action: 'pair_current',
  outcome: 'saved',
  reason: null,
  decision_id: D,
  superseded_decision_ids: [],
  retained_obligation_ids: [OBLIGATION],
  permanent_retirement: false,
  committed_at: '2026-10-09T12:00:00+00:00',
  ...over,
});

describe('readRecoveryReviews', () => {
  it('reads the documented shape', () => {
    const parsed = readRecoveryReviews(body());
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.reviews[0]).toMatchObject({ reason: 'relink_review_required', effect_cents: null, low_cents: -37000, high_cents: 0, withheld_partner_transaction_id: W });
    expect(parsed.reviews[0].candidates[0]).toMatchObject({ transaction_id: W, withheld_by_guard: true });
  });

  it.each([
    ['a reason this build does not know', body({ reviews: [review({ reason: 'provider_verified_return' })] })],
    ['a state this build does not know', body({ reviews: [review({ state: 'settled', reason: 'relink_review_required' })] })],
    ['an "unresolved" included cash leg that carries a definite effect', body({ reviews: [review({ effect_cents: 0, low_cents: 0, high_cents: 0 })] })],
    ['an effect outside its bounds', body({ reviews: [review({ state: 'untracked', reason: 'removed_card', effect_cents: -37000, low_cents: -37000, high_cents: 0 })] })],
    ['bounds the wrong way round', body({ reviews: [review({ low_cents: 0, high_cents: -37000 })] })],
    ['a candidate not marked as a suggestion', body({ reviews: [review({ candidates: [candidate({ suggestion_only: false })] })] })],
    ['a candidate with no suggestion flag at all', body({ reviews: [review({ candidates: [(({ suggestion_only: _s, ...rest }) => rest)(candidate())] })] })],
    ['a withheld leg without the leg it was withheld from', body({ reviews: [review({ withheld_partner_transaction_id: null })] })],
    ['a gap with no reason', body({ reviews: [review({ obligations: [obligation({ origin: 'gap' })] })] })],
    ['an obligation origin this build does not know', body({ reviews: [review({ obligations: [obligation({ origin: 'reconstructed' })] })] })],
    ['an evidence kind this build does not know', body({ reviews: [review({ obligations: [obligation({ sources: [{ ...obligation().sources[0], evidence_kind: 'verified_return' }] })] })] })],
    ['"fresh" with unequal versions', body({ freshness: freshness({ evaluated_version: 6 }) })],
    ['a list that is not current but carries a review', body({ fresh: false, freshness: freshness({ fresh: false, evaluated_version: 6 }) })],
    ['no switch for actions', (({ actions_enabled: _a, ...rest }) => rest)(body())],
    ['an amount in dollars where cents belong', body({ reviews: [review({ amount_cents: 370.5 })] })],
    ['not an object', [body()]],
  ])('is invalid for %s', (_name, value) => {
    expect(readRecoveryReviews(value)).toEqual({ kind: 'invalid' });
  });

  it('a list that is not current is read — with no review in it', () => {
    const parsed = readRecoveryReviews(body({ fresh: false, freshness: freshness({ fresh: false, evaluated_version: 6, refresh: { queued: true, needs_attention: true, attempts: 8 } }), reviews: [], affected_payment_count: 2 }));
    expect(parsed).toMatchObject({ kind: 'ok', fresh: false, affected_payment_count: 2, reviews: [] });
  });
});

describe('readRecoveryAnswer and readRecoveryLookup', () => {
  it('read the three outcomes of an action and the outcome of a refresh request', () => {
    expect(readRecoveryAnswer({ status: 'committed_fresh', receipt: receipt(), freshness: freshness() })).toMatchObject({ kind: 'ok', status: 'committed_fresh' });
    expect(readRecoveryAnswer({ status: 'committed_pending', receipt: receipt(), freshness: freshness({ fresh: false, evaluated_version: 6 }) })).toMatchObject({ kind: 'ok', status: 'committed_pending' });
    expect(readRecoveryAnswer({ status: 'replayed', receipt: receipt(), freshness: freshness() })).toMatchObject({ kind: 'ok', status: 'replayed' });
    expect(readRecoveryAnswer({ status: 'queued', receipt: receipt({ action: 'refresh_retry', outcome: 'queued', decision_id: null }), freshness: freshness() })).toMatchObject({ kind: 'ok', status: 'queued' });
  });

  it.each([
    ['"committed_fresh" while the figures are not current', { status: 'committed_fresh', receipt: receipt(), freshness: freshness({ fresh: false, evaluated_version: 6 }) }],
    ['a receipt that claims a retirement', { status: 'committed_fresh', receipt: receipt({ permanent_retirement: true }), freshness: freshness() }],
    ['a receipt for an action this build does not know', { status: 'committed_fresh', receipt: receipt({ action: 'retire_hold' }), freshness: freshness() }],
    ['a status this build does not know', { status: 'settled', receipt: receipt(), freshness: freshness() }],
    ['no receipt', { status: 'committed_fresh', freshness: freshness() }],
  ])('an answer is invalid for %s', (_name, value) => {
    expect(readRecoveryAnswer(value)).toEqual({ kind: 'invalid' });
  });

  // A removed candidate no decision was written for (graph_source): it names no decision.
  const graphSource = { evidence_kind: 'graph_source', decision_id: null, decision_kind: null, decision_status: null, source_relation: 'removed_candidate', source_date: '2026-09-11', source_cents: -37000, source_known: true };
  const sourcesOf = (value: ReturnType<typeof readRecoveryReviews>) => (value.kind === 'ok' ? value.reviews[0].obligations[0].sources : null);

  it('a graph-observed source names no decision: it is read, beside a decision-backed one, as its own source', () => {
    const read = readRecoveryReviews(body({ reviews: [review({ obligations: [obligation({ sources: [obligation().sources[0], graphSource] })] })] }));
    expect(sourcesOf(read)).toHaveLength(2);
    expect(sourcesOf(read)?.[1]).toEqual({ evidence_kind: 'graph_source', decision_id: null, decision_status: null, source_relation: 'removed_candidate', source_date: '2026-09-11', source_cents: -37000, source_known: true });
  });

  it.each([
    ['a graph-observed source that names a decision', { ...graphSource, decision_id: D }],
    ['a decision-backed source with no decision', { ...graphSource, evidence_kind: 'removed_destination' }],
  ])('is invalid for %s', (_name, source) => {
    expect(readRecoveryReviews(body({ reviews: [review({ obligations: [obligation({ sources: [source] })] })] }))).toEqual({ kind: 'invalid' });
  });

  it('a lookup: found with its receipt, or absent with none', () => {
    expect(readRecoveryLookup({ found: true, receipt: receipt(), freshness: freshness() })).toMatchObject({ kind: 'ok', found: true });
    expect(readRecoveryLookup({ found: false, receipt: null, freshness: freshness() })).toEqual({ kind: 'ok', found: false, receipt: null, freshness: freshness() });
    expect(readRecoveryLookup({ found: false, receipt: receipt(), freshness: freshness() })).toEqual({ kind: 'invalid' });
    expect(readRecoveryLookup({ found: true, receipt: null, freshness: freshness() })).toEqual({ kind: 'invalid' });
  });
});

describe('the summary: an unresolved reason this build does not know', () => {
  const unresolved = (by_reason: Record<string, number>) => ({ count: 1, payments_amount: 370, returns_amount: 0, by_reason });

  it('relink_review_required is a known reason, counted like the others', () => {
    expect(KNOWN_UNRESOLVED_REASONS.has('relink_review_required')).toBe(true);
    const parsed = readSummarySemantics(summaryWire({ currentMonth: unresolvedCashFlowWire({ card_payments_unresolved: unresolved({ relink_review_required: 1 }) }) }));
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(relinkReviewCount(parsed.currentMonth.card_payments_unresolved.by_reason)).toBe(1);
  });

  it('an unknown reason makes the whole summary unusable: the figures are withheld, never shown as if nothing were open', () => {
    const parsed = readSummarySemantics(summaryWire({ currentMonth: unresolvedCashFlowWire({ card_payments_unresolved: unresolved({ some_future_rule: 1 }) }) }));
    expect(parsed).toEqual({ kind: 'invalid' });
    // the same body with a reason this build knows is read
    expect(readSummarySemantics(summaryWire({ currentMonth: unresolvedCashFlowWire({ card_payments_unresolved: unresolved({ ambiguous: 1 }) }) })).kind).toBe('ok');
  });
});

describe('the words for a reading', () => {
  it('a guarded cash payment is a range in words; a guarded card leg says it does not change cash flow', () => {
    const cash = readRecoveryReviews(body());
    const card = readRecoveryReviews(body({ reviews: [review({ side: 'credit', amount_cents: -37000, effect_cents: 0, low_cents: 0, high_cents: 0 })] }));
    if (cash.kind !== 'ok' || card.kind !== 'ok') throw new Error('expected ok');
    expect(reviewReadingText(cash.reviews[0]).detail).toContain('counts this payment as a range: between −$370.00 and $0.00.');
    expect(reviewReadingText(card.reviews[0]).detail).toContain('It does not change cash flow.');
    expect(reviewReadingText(card.reviews[0]).detail).not.toMatch(/\$/);
  });
});
