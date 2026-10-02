-- The evaluator starts once the writer holds L2, waits for it, and must publish exactly the committed
-- input version, having seen all three writes.
select th.wait_for_application('c23-writer-holding-l2');
select set_config('application_name', 'c23-evaluator', false);
set role service_role;
do $$
declare
  v bigint;
begin
  v := public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
  perform th.assert(v = (select input_version from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa'),
    'the published version is the committed input version');
end $$;
