-- PR-42: ephemeral study sessions. One row per spawn of a per-login Instabox VM. The
-- partial unique index is the lease: at most ONE live row (queued, spawning, ready or
-- stopping) per account, so concurrent logins or tabs share one VM. `stopping` keeps the
-- lease on purpose: a new VM must not restore the vault before the old one's final flush.
-- The create Idempotency-Key lives on the row so a resumed spawn replays the same create.
-- `flush_token` is the per-session SYNC_FLUSH_TOKEN; it is never returned by any route.

CREATE TABLE student_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL CHECK (account_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  account_kind text NOT NULL CHECK (account_kind IN ('legacy', 'user')),
  state text NOT NULL CHECK (state IN ('queued', 'spawning', 'ready', 'stopping', 'ended', 'failed')),
  step text CHECK (step IS NULL OR step IN ('create', 'start', 'publish', 'session_start', 'health')),
  machine_name text NOT NULL UNIQUE CHECK (machine_name ~ '^[a-z][a-z0-9-]{0,62}$'),
  machine_id text CHECK (machine_id IS NULL OR machine_id ~ '^m_[a-z0-9]{26}$'),
  url text,
  create_idempotency_key text NOT NULL CHECK (create_idempotency_key ~ '^[\x21-\x7e]{1,200}$'),
  flush_token text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  ended_at timestamptz,
  CONSTRAINT student_sessions_end_consistent CHECK ((state IN ('ended', 'failed')) = (ended_at IS NOT NULL))
);

CREATE UNIQUE INDEX student_sessions_one_live_uidx
  ON student_sessions(account_id)
  WHERE state IN ('queued', 'spawning', 'ready', 'stopping');
CREATE UNIQUE INDEX student_sessions_machine_uidx
  ON student_sessions(machine_id)
  WHERE machine_id IS NOT NULL;
CREATE INDEX student_sessions_state_idx
  ON student_sessions(state, created_at);
