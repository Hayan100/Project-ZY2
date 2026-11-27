-- Up Migration
CREATE TABLE quiz_revisions (
  quiz_id uuid NOT NULL, revision integer NOT NULL CHECK (revision > 0),
  quiz jsonb NOT NULL, authored_by text NOT NULL REFERENCES "user",
  authored_at timestamptz NOT NULL DEFAULT now(),
  published_by text REFERENCES "user", published_at timestamptz,
  PRIMARY KEY (quiz_id,revision),
  CHECK ((published_by IS NULL) = (published_at IS NULL))
);
CREATE TABLE quiz_attempts (
  id uuid PRIMARY KEY, student_id text NOT NULL REFERENCES "user",
  quiz_id uuid NOT NULL, revision integer NOT NULL,
  course_id uuid NOT NULL REFERENCES courses, lesson_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz,
  FOREIGN KEY (quiz_id,revision) REFERENCES quiz_revisions
);
CREATE UNIQUE INDEX quiz_one_open ON quiz_attempts(student_id,quiz_id) WHERE submitted_at IS NULL;
CREATE INDEX quiz_student_history ON quiz_attempts(student_id,started_at DESC);
CREATE TABLE quiz_responses (
  attempt_id uuid NOT NULL REFERENCES quiz_attempts, question_id uuid NOT NULL,
  option_id uuid, correct boolean, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (attempt_id,question_id), CHECK ((option_id IS NULL) = (correct IS NULL))
);

CREATE VIEW lesson_quiz_results AS
SELECT a.id,a.student_id,a.quiz_id,a.revision,a.submitted_at,
  count(*) FILTER (WHERE r.correct)::int AS correct,count(*) FILTER (WHERE NOT r.correct)::int AS incorrect,
  count(*) FILTER (WHERE r.option_id IS NULL)::int AS omitted,count(*)::int AS total
FROM quiz_attempts a JOIN quiz_responses r ON r.attempt_id=a.id WHERE a.submitted_at IS NOT NULL GROUP BY a.id;

-- Down Migration
DROP VIEW lesson_quiz_results;
DROP TABLE quiz_responses, quiz_attempts, quiz_revisions;
