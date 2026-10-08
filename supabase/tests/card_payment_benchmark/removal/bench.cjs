// Generates the psql benchmark script for institution removal with card-payment conversion
// (20261006120000; synthetic data, disposable database only).
//
//   node bench.cjs [samples] [warmups] [sizes] > bench.sql        (defaults 5, 1, "1000,10000,50000")
//   BENCH_FIXTURE=hold_heavy node bench.cjs ...                   (the second fixture variant; default "base")
//
// One fixture per sample, built identically each time for a brand-new user:
//   * the REMOVED institution: a card X and a checking RC, N transactions in all (half each);
//   * a KEPT institution: a checking C and a card Y, N transactions in all;
//   * N/100 card payments from the kept checking C to the removed card X (tier 1 pairs: these are the
//     conversions), and as many from C to the kept card Y (pairs that must stay untouched);
//   * everything else ordinary spending. The user is evaluated, and the removal taken to plaid_removed.
// Two variants of it (the environment variable BENCH_FIXTURE; one variant per generated script):
//   base        as above, unchanged since the first measurement, so its numbers stay comparable. Every
//               payment amount is distinct: no payment to X has a second candidate. The removal writes N/100
//               destination records and NO ambiguity hold.
//   hold_heavy  every payment to X ALSO has a leg of the same amount on the kept card Y, three days after
//               the payment (X's own leg is one day after, so X stays the automatic match and the Y leg is
//               an unmatched competitor). These N/100 legs replace as many ordinary rows of the kept
//               institution: the totals stay N and N. Each payment to X is then an owner that was matched
//               automatically to the removed card and has one kept competitor: the removal writes N/100
//               destination records AND N/100 ambiguity holds, and its final evaluation reads N/100 live
//               holds (each withholds the pair of the payment and the kept leg).
// Measured, each on its own fixture:
//   previous   the 20260926120000 function (installed in this throwaway database under another name,
//              from the real migration text): no evaluation, no conversion — what a removal cost before;
//   current    public.remove_plaid_item_local as 20261006120000 installs it;
//   steps      the four statements the current function adds or contains, run one by one in one
//              transaction with the clock read between them: first evaluation, preservation (the user-pair
//              statement, the automatic-pair statement the comments below call the conversion, then the
//              ambiguity-hold statement), delete (the cascade and its triggers), final evaluation
//              (best-effort: try_evaluate_card_payments, as the function calls it). Rolled back.
//              "step 2: conversion" is the three preservation statements together, as it always was; the
//              clock is now also read between them, and each is reported on its own (steps 2a, 2b, 2c).
//              Two of those extra clock reads (two local round trips) are inside step 2; the gap in which
//              the ambiguity-hold plan is taken is not.
// previous / current samples are one committed statement each, timed with the server's clock_timestamp()
// read just before and just after (so the commit and two local round trips are included, identically in
// both). Between samples the fixture's user is deleted and the affected tables vacuumed, untimed.
// Also printed: the checksums of the function bodies measured; the rows the removal reads and writes (its
// destination records, its ambiguity holds, the holds its final evaluation applied); and, at each size, the
// plan of the conversion's SELECT and the plan of the ambiguity-hold statement's SELECT (EXPLAIN ANALYZE).
//
// These are local measurements for a report. Not a pass/fail test, never correctness evidence.
//
// SAFETY: the generated script truncates auth.users. It refuses to run unless psql is given
// -v bench_disposable=1 (run.sh does) AND auth.users is empty (a fresh throwaway database).
const fs = require('fs');
const path = require('path');

const samples = Number(process.argv[2] ?? 5);
const warmups = Number(process.argv[3] ?? 1);
const SIZES = (process.argv[4] ?? '1000,10000,50000').split(',').map(Number);
const VARIANT = process.env.BENCH_FIXTURE || 'base';
if (!['base', 'hold_heavy'].includes(VARIANT)) throw new Error(`BENCH_FIXTURE must be base or hold_heavy, not ${VARIANT}`);
const HOLD_HEAVY = VARIANT === 'hold_heavy';
const ROOT = path.resolve(__dirname, '../../../..');
const OLD = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260926120000_linked_institution_management.sql'), 'utf8').replace(/\r\n/g, '\n');
const NEW = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261006120000_lim_removal_card_payment_matching.sql'), 'utf8').replace(/\r\n/g, '\n');

function definition(text, head) {
  const start = text.indexOf(head);
  if (start < 0 || text.indexOf(head, start + 1) >= 0) throw new Error(`definition not unique: ${head}`);
  return text.slice(start, text.indexOf('\n$$;', start) + 4);
}
const previous = definition(OLD, 'create function public.remove_plaid_item_local(')
  .replace('create function public.remove_plaid_item_local(', 'create function bench.remove_previous(');
// The conversion statement, taken from the real function text (so the benchmark cannot drift from it).
const current = definition(NEW, 'create or replace function public.remove_plaid_item_local(');
const convStart = current.indexOf('    insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents)');
const convEnd = current.indexOf('    order by t.id;', convStart) + '    order by t.id;'.length;
if (convStart < 0 || convEnd < convStart) throw new Error('conversion statement not found');
const conversion = current.slice(convStart, convEnd)
  .replace(/p_user_id/g, ":'u'::uuid").replace(/p_item_id/g, ":'item'::uuid").replace(/v_evaluated/g, ':v');
const conversionSelect = conversion.slice(conversion.indexOf('    select '));
// The statement that preserves USER-confirmed pairs, taken from the function text the same way. This
// fixture has no user decision, so it measures the statement's fixed cost, not a per-pair cost.
const userStart = current.indexOf('    insert into public.card_payment_decisions\n      (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_plaid_transaction_id, b_cents,');
const userEnd = current.indexOf('    order by d.id;', userStart) + '    order by d.id;'.length;
if (userStart < 0 || userEnd < userStart) throw new Error('user-pair preservation statement not found');
const userPairs = current.slice(userStart, userEnd)
  .replace(/p_user_id/g, ":'u'::uuid").replace(/p_item_id/g, ":'item'::uuid").replace(/v_evaluated/g, ':v');
// The statement that writes the system ambiguity holds, taken the same way. It reads the evaluator's scratch
// tables, not the published states: pg_temp.cpe_pool as the owner, as its candidates on the removed
// institution and as its candidates that stay (each joined to cpe_txn by primary key), cpe_tier1 and the
// pool once more for the account of the owner's automatic partner, and cpe_dismissed. Those tables exist
// only in the transaction that evaluated, so the statement can run on its own only where it runs below: in
// the steps transaction, after the first evaluation.
//   * base fixture: every pool leg of the kept institution is read as a possible owner, and each of the N/100
//     payments to the removed card finds its one removed candidate — but none has a candidate that stays
//     (every amount is distinct), so the joins run and NO hold is written. Not exercised: writing a hold,
//     a later evaluation reading one, a dismissed pair (cpe_dismissed is empty), an existing hold to skip.
//   * hold_heavy fixture: each of those N/100 payments also finds one kept candidate, so N/100 holds are
//     written, one per payment (one removed candidate, one kept competitor each), and the final evaluation
//     reads them. Still not exercised: several candidates per owner, dismissals, existing holds, an owner
//     that had no automatic match, and the mirror kind (a removed cash account).
const holdStart = current.indexOf('    insert into public.card_payment_decisions\n      (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents,\n       counterpart_date)');
const holdEnd = current.indexOf('    order by 2, 3, 4, 6, 7, 9;', holdStart) + '    order by 2, 3, 4, 6, 7, 9;'.length;
if (holdStart < 0 || holdEnd < holdStart) throw new Error('ambiguity-hold statement not found');
const ambiguityHolds = current.slice(holdStart, holdEnd)
  .replace(/p_user_id/g, ":'u'::uuid").replace(/p_item_id/g, ":'item'::uuid").replace(/v_evaluated/g, ':v');
const holdSelect = ambiguityHolds.slice(ambiguityHolds.indexOf('    select distinct '));
if (!holdSelect.startsWith('    select distinct ') || !holdSelect.includes('pg_temp.cpe_pool')) throw new Error('ambiguity-hold SELECT not found');

const out = [];
const p = (s) => out.push(s);
p('\\set ON_ERROR_STOP 1');
p('\\if :{?bench_disposable}');
p('\\else');
p("do $$ begin raise exception 'REFUSING: run only through supabase/tests/card_payment_benchmark/removal/run.sh (a throwaway container)'; end $$;");
p('\\endif');
p("do $$ begin if exists (select 1 from auth.users) then raise exception 'REFUSING: auth.users is not empty; this benchmark truncates it and must only run on a fresh throwaway database'; end if; end $$;");
p('set client_min_messages = warning;');
p('create schema bench;');
p('grant usage on schema bench to service_role;');
p('create table bench.results (phase text, size integer, sample integer, seconds double precision);');
p('create table bench.counts (size integer, what text, n bigint);');
p('truncate auth.users cascade;');
p(previous);
p('grant execute on function bench.remove_previous(uuid, uuid) to service_role;');
p(`\\echo fixture variant: ${VARIANT}${HOLD_HEAVY ? ' (every payment to the removed card also has a same-amount leg on the kept card, three days later)' : ' (no payment to the removed card has a second candidate)'}`);
p('\\echo function bodies measured (md5 of the LF-normalised source)');
p(`select p.oid::regprocedure as function, md5(replace(p.prosrc, E'\\r', '')) as body_md5 from pg_proc p where p.oid in ('bench.remove_previous(uuid, uuid)'::regprocedure, 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure, 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure, 'public.try_evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) order by 1;`);
// The fixture. Ids are derived from the user's uuid so every sample is independent.
p(`create function bench.build(p_user uuid, p_n integer) returns uuid language plpgsql as $$
declare
  v_removed uuid := gen_random_uuid();
  v_kept uuid := gen_random_uuid();
  v_x uuid := gen_random_uuid();
  v_rc uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_y uuid := gen_random_uuid();
  v_pairs integer := greatest(p_n / 100, 1);
  v_tag text := replace(p_user::text, '-', '');
begin
  insert into auth.users (id, email) values (p_user, v_tag || '@example.test');
  insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
    (v_removed, p_user, 'bench-removed-' || v_tag, 'placeholder', 'Removed'), (v_kept, p_user, 'bench-kept-' || v_tag, 'placeholder', 'Kept');
  insert into public.accounts (id, item_id, plaid_account_id, name, type) values
    (v_x, v_removed, 'x-' || v_tag, 'Card X', 'credit'), (v_rc, v_removed, 'rc-' || v_tag, 'Checking RC', 'depository'),
    (v_c, v_kept, 'c-' || v_tag, 'Checking C', 'depository'), (v_y, v_kept, 'y-' || v_tag, 'Card Y', 'credit');
  -- Ordinary rows: p_n on the removed institution, p_n on the kept one (minus the card legs below).
  insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version)
  select case when g % 2 = 0 then v_x else v_rc end, 'r-' || v_tag || '-' || g, 5 + (g % 400), date '2024-01-01' + (g % 700), 'Row', 'expense', 'sign_default', 'low', 1
  from generate_series(1, p_n - v_pairs) g;
  insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version)
  select case when g % 4 = 0 then v_y else v_c end, 'k-' || v_tag || '-' || g, 5 + (g % 400), date '2024-01-01' + (g % 700), 'Row', 'expense', 'sign_default', 'low', 1
  from generate_series(1, p_n - ${HOLD_HEAVY ? 4 : 3} * v_pairs) g;
  -- Card payments: C -> X (the pairs a removal converts) and C -> Y (pairs that stay). Distinct cents per pair.
  insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version)
  select v_c, 'kx-' || v_tag || '-' || g, 1000 + g * 0.01, date '2024-01-01' + (g % 700), 'Payment', 'credit_card_payment', 'category_detailed', 'high', 1 from generate_series(1, v_pairs) g
  union all
  select v_x, 'x-' || v_tag || '-' || g, -(1000 + g * 0.01), date '2024-01-02' + (g % 700), 'Payment', 'credit_card_payment', 'category_detailed', 'high', 1 from generate_series(1, v_pairs) g
  union all
  select v_c, 'ky-' || v_tag || '-' || g, 5000 + g * 0.01, date '2024-01-01' + (g % 700), 'Payment', 'credit_card_payment', 'category_detailed', 'high', 1 from generate_series(1, v_pairs) g
  union all
  select v_y, 'y-' || v_tag || '-' || g, -(5000 + g * 0.01), date '2024-01-02' + (g % 700), 'Payment', 'credit_card_payment', 'category_detailed', 'high', 1 from generate_series(1, v_pairs) g${HOLD_HEAVY ? `
  union all
  -- hold_heavy: a leg on the kept card Y of the same amount as each C -> X payment, three days after the payment
  -- (the leg on X is one day after it: X is the closest candidate and stays the automatic match).
  select v_y, 'yh-' || v_tag || '-' || g, -(1000 + g * 0.01), date '2024-01-04' + (g % 700), 'Payment', 'credit_card_payment', 'category_detailed', 'high', 1 from generate_series(1, v_pairs) g` : ''};
  perform public.evaluate_card_payments(p_user);
  perform public.begin_plaid_item_removal(p_user, v_removed, public.plaid_item_removal_digest(p_user, v_removed));
  perform public.record_plaid_item_removal_attempt(p_user, v_removed, 'removed', null);
  return v_removed;
end $$;`);
p(`create function bench.check_fixture(p_user uuid, p_n integer) returns void language plpgsql as $$
begin
  if (select count(*) from public.card_payment_auto_pairs where user_id = p_user) <> 2 * greatest(p_n / 100, 1)
     or (select count(*) from public.card_payment_leg_states where user_id = p_user) <> ${HOLD_HEAVY ? 5 : 4} * greatest(p_n / 100, 1)
     or (select count(*) from public.card_payment_leg_states where user_id = p_user and state = 'unresolved') <> ${HOLD_HEAVY ? 1 : 0} * greatest(p_n / 100, 1)
     or not coalesce((public.get_card_payment_states(p_user)->>'fresh')::boolean, false) then
    raise exception 'fixture is not what the benchmark describes';
  end if;
end $$;`);

const vacuum = 'vacuum (analyze) public.transactions, public.accounts, public.plaid_items, public.card_payment_leg_states, public.card_payment_auto_pairs, public.card_payment_decision_states, public.card_payment_decisions, public.card_payment_eval_versions;';
let serial = 0;
/** A new user and its fixture; sets psql variables u and item. */
function fixture(n) {
  serial += 1;
  const u = `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`;
  p(`\\set u '${u}'`);
  p(`select bench.build(:'u'::uuid, ${n}) as item \\gset`);
  p(`select bench.check_fixture(:'u'::uuid, ${n}) \\g /dev/null`);
  p(vacuum);
}
// plaid_items does not cascade from auth.users: delete the user's items first (accounts and rows cascade).
const cleanup = () => {
  p(`delete from public.plaid_items where user_id = :'u'::uuid;`);
  p(`delete from auth.users where id = :'u'::uuid;`);
  p(vacuum);
};

for (const n of SIZES) {
  p(`\\echo size ${n}`);
  for (let s = 1 - warmups; s <= samples; s++) {
    for (const [phase, call] of [['previous', 'bench.remove_previous'], ['current', 'public.remove_plaid_item_local']]) {
      fixture(n);
      p('set role service_role;');
      p('select clock_timestamp() as t0 \\gset');
      p(`select ${call}(:'u'::uuid, :'item'::uuid) \\g /dev/null`);
      p('select extract(epoch from clock_timestamp() - :\'t0\'::timestamptz) as secs \\gset');
      p('reset role;');
      if (s >= 1) p(`insert into bench.results values ('${phase}', ${n}, ${s}, :secs);`);
      if (phase === 'current' && s === 1) {
        p(`insert into bench.counts select ${n}, 'records written by the removal', count(*) from public.card_payment_decisions where user_id = :'u'::uuid and kind = 'destination_removed_card';`);
        p(`insert into bench.counts select ${n}, 'surviving legs evaluated after the removal', count(*) from public.card_payment_leg_states where user_id = :'u'::uuid;`);
        p(`insert into bench.counts select ${n}, 'ambiguity holds written by the removal', count(*) from public.card_payment_decisions where user_id = :'u'::uuid and kind in ('ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account');`);
        p(`insert into bench.counts select ${n}, 'live holds applied by the final evaluation', count(*) from public.card_payment_decision_states where user_id = :'u'::uuid and kind in ('ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account') and status = 'active';`);
        p(`insert into bench.counts select ${n}, 'automatic pairs left after the removal', count(*) from public.card_payment_auto_pairs where user_id = :'u'::uuid;`);
        p(`insert into bench.counts select ${n}, 'payments read untracked / removed_card after the removal', count(*) from public.card_payment_leg_states where user_id = :'u'::uuid and state = 'untracked' and reason = 'removed_card';`);
        // What the variant says the removal writes, checked (the fixture, not the function, is what this guards).
        const pairs = Math.max(Math.floor(n / 100), 1);
        p(`do $$ begin if exists (select 1 from (values ('records written by the removal', ${pairs}), ('ambiguity holds written by the removal', ${HOLD_HEAVY ? pairs : 0}), ('live holds applied by the final evaluation', ${HOLD_HEAVY ? pairs : 0}), ('automatic pairs left after the removal', ${pairs}), ('payments read untracked / removed_card after the removal', ${pairs}), ('surviving legs evaluated after the removal', ${(HOLD_HEAVY ? 4 : 3) * pairs})) e(what, n) where not exists (select 1 from bench.counts c where c.size = ${n} and c.what = e.what and c.n = e.n)) then raise exception 'the removal did not write what the ${VARIANT} fixture describes at size ${n}'; end if; end $$;`);
        p(`do $$ begin if not coalesce((public.get_card_payment_states('${`00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`}')->>'fresh')::boolean, false) then raise exception 'the removal did not end fresh'; end if; end $$;`);
      }
      cleanup();
    }
    // The steps, one by one, in one transaction (rolled back).
    fixture(n);
    if (s === 1) {
      p(`insert into bench.counts select ${n}, 'transactions of the user', count(*) from public.transactions t join public.accounts a on a.id = t.account_id join public.plaid_items i on i.id = a.item_id where i.user_id = :'u'::uuid;`);
      p(`insert into bench.counts select ${n}, 'transactions on the removed institution', count(*) from public.transactions t join public.accounts a on a.id = t.account_id where a.item_id = :'item'::uuid;`);
      p(`insert into bench.counts select ${n}, 'leg states read by the conversion (all of the user''s)', count(*) from public.card_payment_leg_states where user_id = :'u'::uuid;`);
    }
    p('begin;');
    p('set local role service_role;');
    p('select clock_timestamp() as t0 \\gset');
    p(`select public.evaluate_card_payments(:'u'::uuid) as v \\gset`);
    p('select clock_timestamp() as t1 \\gset');
    if (s === 1) {
      // The plan of the conversion's SELECT (it runs the SELECT only; untimed, between the two clock reads).
      p(`\\echo conversion plan at size ${n}:`);
      p(`explain (analyze, buffers off, timing off, summary off, costs off)\n${conversionSelect}`);
    }
    p('select clock_timestamp() as t1b \\gset');
    p(userPairs);
    p('select clock_timestamp() as t1c \\gset');
    p(conversion);
    p('select clock_timestamp() as t1d \\gset');
    if (s === 1) {
      // The plan of the ambiguity-hold statement's SELECT (the SELECT only; untimed, between two clock reads),
      // taken where the statement runs: after the evaluation that left the scratch tables it reads AND after
      // the conversion wrote its records, which are the rows of card_payment_decisions that its NOT EXISTS
      // then has to pass over. EXPLAIN (ANALYZE, BUFFERS) in full: the estimates matter — cpe_tier1 and
      // cpe_dismissed are never analyzed — and the execution time is the statement's read cost on its own.
      // It runs the same SELECT just before the timed statement, so in this one sample step 2c starts warm.
      p(`\\echo ambiguity-hold plan at size ${n}:`);
      p(`explain (analyze, buffers)\n${holdSelect}`);
    }
    p('select clock_timestamp() as t1e \\gset');
    p(ambiguityHolds);
    p('select clock_timestamp() as t2 \\gset');
    p(`delete from public.plaid_items where id = :'item'::uuid and user_id = :'u'::uuid;`);
    p('select clock_timestamp() as t3 \\gset');
    p(`select public.try_evaluate_card_payments(:'u'::uuid) \\g /dev/null`);
    p('select clock_timestamp() as t4 \\gset');
    p('rollback;');
    if (s >= 1) {
      p(`insert into bench.results values ('step 1: first evaluation', ${n}, ${s}, extract(epoch from :'t1'::timestamptz - :'t0'::timestamptz)),`);
      p(`  ('step 2: conversion', ${n}, ${s}, extract(epoch from (:'t1d'::timestamptz - :'t1b'::timestamptz) + (:'t2'::timestamptz - :'t1e'::timestamptz))),`);
      p(`  ('step 2a: user-pair statement', ${n}, ${s}, extract(epoch from :'t1c'::timestamptz - :'t1b'::timestamptz)),`);
      p(`  ('step 2b: automatic-pair statement', ${n}, ${s}, extract(epoch from :'t1d'::timestamptz - :'t1c'::timestamptz)),`);
      p(`  ('step 2c: ambiguity-hold statement', ${n}, ${s}, extract(epoch from :'t2'::timestamptz - :'t1e'::timestamptz)),`);
      p(`  ('step 3: delete (cascade + triggers)', ${n}, ${s}, extract(epoch from :'t3'::timestamptz - :'t2'::timestamptz)),`);
      p(`  ('step 4: final evaluation', ${n}, ${s}, extract(epoch from :'t4'::timestamptz - :'t3'::timestamptz));`);
    }
    cleanup();
  }
}

// Report.
p('\\echo');
p('\\echo counts (first measured sample of each size)');
p('select size, what, n from bench.counts order by size, what;');
p('\\echo');
p('\\echo timings (milliseconds)');
p(`select size, phase, count(*) as n, round((percentile_cont(0.5) within group (order by seconds) * 1000)::numeric, 1) as median_ms, round((min(seconds) * 1000)::numeric, 1) as min_ms, round((max(seconds) * 1000)::numeric, 1) as max_ms from bench.results group by size, phase order by size, phase;`);
p('\\echo');
p('\\echo added by 20261006120000 (median current - median previous)');
p(`with m as (select size, phase, percentile_cont(0.5) within group (order by seconds) as med from bench.results where phase in ('previous', 'current') group by 1, 2) select c.size, round((p.med * 1000)::numeric, 1) as previous_ms, round((c.med * 1000)::numeric, 1) as current_ms, round(((c.med - p.med) * 1000)::numeric, 1) as added_ms, round(((c.med / p.med - 1) * 100)::numeric, 0) as added_pct from m c join m p on p.size = c.size and p.phase = 'previous' where c.phase = 'current' order by c.size;`);
process.stdout.write(out.join('\n') + '\n');
