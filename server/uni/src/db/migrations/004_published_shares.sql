-- PR-23: authenticated cohort sharing. Published shares are database rows whose
-- sender, programme and cohort are stamped from the approved enrolment at insert
-- time — the columns are never writable from the request body. Idempotent publish
-- is enforced by the (profile, key) unique index; withdrawal is a state change,
-- not a delete, and every lifecycle action lands in share_moderation_events.
-- Legacy file-relay shares are NOT imported: their authors were never verified,
-- so they stay quarantined pending an explicit, consented migration.

CREATE TABLE published_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_profile_id uuid NOT NULL REFERENCES student_profiles(id) ON DELETE RESTRICT,
  programme_code text NOT NULL CHECK (programme_code ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'),
  cohort_code text NOT NULL CHECK (cohort_code ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'),
  sender_name text NOT NULL CHECK (char_length(btrim(sender_name)) BETWEEN 1 AND 80),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  state text NOT NULL DEFAULT 'published' CHECK (state IN ('published', 'withdrawn')),
  payload jsonb NOT NULL,
  payload_bytes integer NOT NULL CHECK (payload_bytes > 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  CONSTRAINT published_shares_withdraw_consistent
    CHECK (state = 'published' OR withdrawn_at IS NOT NULL)
);

CREATE UNIQUE INDEX published_shares_idempotency_uidx
  ON published_shares(student_profile_id, idempotency_key);
CREATE INDEX published_shares_feed_idx
  ON published_shares(cohort_code, created_at DESC, id DESC);
CREATE INDEX published_shares_sender_idx
  ON published_shares(student_profile_id, created_at DESC);

CREATE TABLE share_moderation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id uuid NOT NULL REFERENCES published_shares(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('withdraw', 'remove')),
  actor_subject text NOT NULL CHECK (char_length(btrim(actor_subject)) BETWEEN 1 AND 255),
  note text CHECK (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 1000),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX share_moderation_events_share_idx ON share_moderation_events(share_id, occurred_at);
