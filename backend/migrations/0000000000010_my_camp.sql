-- Up Migration
CREATE VIEW active_planner_batches AS
SELECT DISTINCT e.user_id,o.batch_id,e.starts_at,e.ends_at FROM enrollments e JOIN payment_receipts r ON r.enrollment_id=e.id AND r.part=1
JOIN payment_invoices i ON i.id=r.invoice_id JOIN payment_offers o ON o.id=i.offer_id
WHERE o.batch_id IS NOT NULL AND e.revoked_at IS NULL AND e.starts_at<=now() AND now()<e.ends_at;

CREATE TABLE planner_events (
  id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),batch_id uuid NOT NULL REFERENCES admission_batches,
  kind text NOT NULL CHECK(kind IN ('class','chapter_test','mock','revision')), title text NOT NULL,
  starts_at timestamptz NOT NULL, minutes integer NOT NULL CHECK(minutes BETWEEN 1 AND 1440),
  published_by text NOT NULL REFERENCES "user",published_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(id,revision)
);
CREATE VIEW current_planner_events AS SELECT DISTINCT ON(id) * FROM planner_events ORDER BY id,revision DESC;
CREATE TABLE planner_tasks (
  id uuid PRIMARY KEY,student_id text NOT NULL REFERENCES "user",created_by text NOT NULL REFERENCES "user",
  title text NOT NULL,starts_at timestamptz NOT NULL,minutes integer NOT NULL CHECK(minutes BETWEEN 1 AND 1440),
  deadline timestamptz,fixed boolean NOT NULL,course_id uuid REFERENCES courses,lesson_id uuid,
  completed_at timestamptz,version integer NOT NULL DEFAULT 1,
  CHECK ((course_id IS NULL)=(lesson_id IS NULL)),
  CHECK (deadline IS NULL OR starts_at+minutes*interval '1 minute'<=deadline)
);
CREATE INDEX planner_student_time ON planner_tasks(student_id,starts_at);
CREATE TABLE planner_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recipient text NOT NULL REFERENCES "user",actor text NOT NULL REFERENCES "user",
  item_id uuid NOT NULL,kind text NOT NULL,old_start timestamptz,new_start timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX planner_notice_recipient ON planner_notices(recipient,created_at);
CREATE TABLE accepted_plans (
  student_id text NOT NULL REFERENCES "user", token text NOT NULL,profile jsonb NOT NULL,accepted_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(student_id,token)
);

-- Down Migration
DROP VIEW current_planner_events,active_planner_batches;
DROP TABLE accepted_plans, planner_notices, planner_tasks, planner_events;
