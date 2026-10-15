CREATE TABLE student_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL CHECK (char_length(btrim(legal_name)) BETWEEN 1 AND 200),
  preferred_name text CHECK (preferred_name IS NULL OR char_length(btrim(preferred_name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE enrolments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_profile_id uuid NOT NULL REFERENCES student_profiles(id) ON DELETE RESTRICT,
  programme_code text NOT NULL CHECK (programme_code ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  cohort_code text NOT NULL CHECK (cohort_code ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'withdrawn', 'suspended')),
  starts_on date NOT NULL,
  ends_on date CHECK (ends_on IS NULL OR ends_on >= starts_on),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT enrolments_student_programme_cohort_unique UNIQUE (student_profile_id, programme_code, cohort_code)
);

CREATE INDEX enrolments_student_profile_id_idx ON enrolments(student_profile_id);

CREATE TABLE course_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id uuid NOT NULL REFERENCES enrolments(id) ON DELETE RESTRICT,
  course_code text NOT NULL CHECK (course_code ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  status text NOT NULL DEFAULT 'selected' CHECK (status IN ('selected', 'completed', 'withdrawn')),
  selected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT course_selections_enrolment_course_unique UNIQUE (enrolment_id, course_code)
);

CREATE INDEX course_selections_enrolment_id_idx ON course_selections(enrolment_id);

CREATE TABLE staff_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_subject text NOT NULL CHECK (char_length(btrim(staff_subject)) BETWEEN 1 AND 255),
  institution_code text NOT NULL DEFAULT 'SEF' CHECK (institution_code ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('registrar', 'lecturer', 'support')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'ended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT staff_memberships_subject_institution_unique UNIQUE (staff_subject, institution_code)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_membership_id uuid REFERENCES staff_memberships(id) ON DELETE SET NULL,
  actor_subject text NOT NULL CHECK (char_length(btrim(actor_subject)) BETWEEN 1 AND 255),
  event_type text NOT NULL CHECK (char_length(btrim(event_type)) BETWEEN 1 AND 100),
  subject_type text NOT NULL CHECK (char_length(btrim(subject_type)) BETWEEN 1 AND 100),
  subject_id text NOT NULL CHECK (char_length(btrim(subject_id)) BETWEEN 1 AND 255),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_occurred_at_idx ON audit_events(occurred_at DESC);
CREATE INDEX audit_events_subject_idx ON audit_events(subject_type, subject_id, occurred_at DESC);
