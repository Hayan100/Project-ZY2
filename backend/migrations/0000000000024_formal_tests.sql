-- Up Migration
CREATE TABLE formal_tests (
  id uuid PRIMARY KEY, author text NOT NULL REFERENCES "user", quiz jsonb NOT NULL, rules jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE formal_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event uuid NOT NULL REFERENCES formal_tests,student text NOT NULL REFERENCES "user",
  form jsonb NOT NULL,registered_at timestamptz NOT NULL DEFAULT now(), UNIQUE(event,student)
);
CREATE TABLE formal_attempts (
  id uuid PRIMARY KEY,registration uuid NOT NULL REFERENCES formal_registrations, ranked boolean NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), deadline timestamptz NOT NULL, hard_close timestamptz NOT NULL,
  paused_at timestamptz, submitted_at timestamptz,version integer NOT NULL DEFAULT 0,
  answers jsonb NOT NULL DEFAULT '{}',superseded boolean NOT NULL DEFAULT false
);
CREATE INDEX formal_attempt_registration ON formal_attempts(registration);
CREATE TABLE formal_resets (
  original uuid PRIMARY KEY REFERENCES formal_attempts,replacement uuid NOT NULL UNIQUE REFERENCES formal_attempts,
  reviewer text NOT NULL REFERENCES "user",reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE formal_late_changes (
  attempt uuid REFERENCES formal_attempts,id uuid,changes jsonb NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(attempt,id)
);
CREATE VIEW formal_scores AS
  SELECT a.id,r.event,r.student,r.id AS registration,a.ranked,a.started_at,
    coalesce(a.submitted_at,CASE WHEN a.paused_at IS NULL THEN a.deadline ELSE a.hard_close END) AS finished_at,
    count(*) FILTER(WHERE a.answers->>(q->>'id')=q->>'correctOptionId')::int AS correct,
    count(*) FILTER(WHERE a.answers->>(q->>'id')<>q->>'correctOptionId')::int AS incorrect,
    count(*) FILTER(WHERE a.answers->>(q->>'id') IS NULL)::int AS omitted,
    sum(CASE WHEN a.answers->>(q->>'id') IS NULL THEN (t.rules->>'omitPoints')::int
      WHEN a.answers->>(q->>'id')=q->>'correctOptionId' THEN (t.rules->>'correctPoints')::int
      ELSE (t.rules->>'wrongPoints')::int END)::int AS score
  FROM formal_attempts a JOIN formal_registrations r ON r.id=a.registration JOIN formal_tests t ON t.id=r.event
    CROSS JOIN LATERAL jsonb_array_elements(t.quiz->'questions') q
  WHERE NOT a.superseded AND (a.submitted_at IS NOT NULL OR now()>=CASE WHEN a.paused_at IS NULL THEN a.deadline ELSE a.hard_close END)
  GROUP BY a.id,r.id;
-- Down Migration
DROP VIEW formal_scores;
DROP TABLE formal_late_changes,formal_resets,formal_attempts,formal_registrations,formal_tests;
