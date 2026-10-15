-- PR-05: admission lifecycle. Aligns the PR-03 foundation tables with the shared
-- Enrolment contract (pending/approved/rejected/suspended/withdrawn), links student
-- profiles and staff memberships to better-auth users, and adds erasure requests.

-- student_profiles gains its link to the auth account and an account-level status
-- (distinct from enrolment suspension: a suspended profile cannot hold sessions).
ALTER TABLE student_profiles
  ADD COLUMN account_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'));

CREATE UNIQUE INDEX student_profiles_account_user_id_uidx
  ON student_profiles(account_user_id) WHERE account_user_id IS NOT NULL;

-- enrolments: real cohort codes are lowercase slugs ('bsc-pma-2026'); relax the
-- code patterns, make cohort nullable until approval, and carry decision provenance.
ALTER TABLE enrolments
  RENAME COLUMN created_at TO requested_at;

ALTER TABLE enrolments
  DROP CONSTRAINT enrolments_student_programme_cohort_unique,
  DROP CONSTRAINT enrolments_programme_code_check,
  DROP CONSTRAINT enrolments_cohort_code_check,
  DROP CONSTRAINT enrolments_status_check,
  ALTER COLUMN cohort_code DROP NOT NULL,
  ALTER COLUMN status SET DEFAULT 'pending',
  ADD COLUMN curriculum_version text NOT NULL DEFAULT 'unknown',
  ADD COLUMN decision_actor_subject text CHECK (decision_actor_subject IS NULL OR char_length(btrim(decision_actor_subject)) BETWEEN 1 AND 255),
  ADD COLUMN decision_at timestamptz,
  ADD COLUMN decision_reason text CHECK (decision_reason IS NULL OR char_length(btrim(decision_reason)) BETWEEN 1 AND 2000),
  DROP COLUMN starts_on,
  DROP COLUMN ends_on;

-- Rows written under the pre-admission statuses are preserved as withdrawn so the
-- decision provenance the new constraints require stays truthful.
UPDATE enrolments
  SET status = 'withdrawn',
      decision_actor_subject = 'migration-003',
      decision_at = now(),
      decision_reason = 'Pre-admission-lifecycle row preserved as withdrawn'
  WHERE status IN ('active', 'completed');

ALTER TABLE enrolments
  ADD CONSTRAINT enrolments_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'suspended', 'withdrawn')),
  ADD CONSTRAINT enrolments_programme_code_check
    CHECK (programme_code ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'),
  ADD CONSTRAINT enrolments_cohort_code_check
    CHECK (cohort_code IS NULL OR cohort_code ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'),
  ADD CONSTRAINT enrolments_pending_clean
    CHECK (status <> 'pending' OR (cohort_code IS NULL AND decision_at IS NULL)),
  ADD CONSTRAINT enrolments_decided_carry_cohort
    CHECK (status NOT IN ('approved', 'suspended') OR cohort_code IS NOT NULL),
  ADD CONSTRAINT enrolments_decided_carry_decision
    CHECK (status = 'pending' OR (decision_at IS NOT NULL AND decision_reason IS NOT NULL)),
  ADD CONSTRAINT enrolments_student_programme_unique UNIQUE (student_profile_id, programme_code);

CREATE INDEX enrolments_status_idx ON enrolments(status);
CREATE INDEX student_profiles_status_idx ON student_profiles(status);

ALTER TABLE staff_memberships DROP CONSTRAINT staff_memberships_role_check;
ALTER TABLE staff_memberships
  ADD CONSTRAINT staff_memberships_role_check
    CHECK (role IN ('owner', 'registrar', 'lecturer', 'support'));

-- A student flags erasure; a staff member confirms it. Confirmation anonymizes the
-- profile and account rows (see src/enrolments.ts) and revokes sessions, so a
-- confirmed request is terminal for the account link.
CREATE TABLE erasure_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_profile_id uuid NOT NULL REFERENCES student_profiles(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  confirmed_by_subject text CHECK (confirmed_by_subject IS NULL OR char_length(btrim(confirmed_by_subject)) BETWEEN 1 AND 255),
  CONSTRAINT erasure_requests_confirmed_consistent
    CHECK (status = 'pending' OR (confirmed_at IS NOT NULL AND confirmed_by_subject IS NOT NULL))
);

CREATE INDEX erasure_requests_status_idx ON erasure_requests(status);
CREATE UNIQUE INDEX erasure_requests_one_pending_per_profile
  ON erasure_requests(student_profile_id) WHERE status = 'pending';
