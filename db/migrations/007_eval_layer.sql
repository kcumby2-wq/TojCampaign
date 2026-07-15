-- 007: Eval layer — quality guardrails that run before agent output reaches the human.
--
-- Every completed agent_run goes through an evaluator that scores it against
-- namespace-specific rules (TOJ principles, Hooks principles, or per-role
-- custom rules). If it fails, the orchestrator retries up to 3 times with
-- the evaluator's feedback appended. After 3 failures, the run lands in
-- 'Waiting' with the retry history attached for human review (option B).

-- New columns on agent_runs
alter table agent_runs add column if not exists eval_status text default 'not_run';
  -- values: not_run | passed | passed_after_retry | failed_after_retries
alter table agent_runs add column if not exists retry_count int default 0;
alter table agent_runs add column if not exists eval_summary text;
  -- one-line summary of what the evaluator saw (surfaced to human in Waiting)
alter table agent_runs add column if not exists eval_biggest_miss text;
  -- the biggest miss field from the evaluator output

create index if not exists agent_runs_eval_status_idx
  on agent_runs(eval_status, created_at desc);

-- Eval runs — one row per evaluator call, so we can audit exactly what
-- the evaluator saw and how it scored. Multiple eval_runs per agent_run
-- when there are retries.
create table if not exists eval_runs (
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid not null references agent_runs(id) on delete cascade,
  attempt int not null,
  verdict text not null,           -- 'PASS' | 'FAIL'
  total_score int,                 -- sum of question scores
  scores jsonb,                    -- [{question_id, score, justification}, ...]
  biggest_miss text,
  retry_guidance text,             -- feedback appended to retry
  auto_fail_triggered text,        -- name of auto-fail rule if hit
  evaluator_model text,            -- 'claude-haiku-4-5' | 'claude-opus-4-8' etc.
  usage jsonb,                     -- token usage of the eval call itself
  created_at timestamptz not null default now()
);

create index if not exists eval_runs_agent_run_idx
  on eval_runs(agent_run_id, attempt);
