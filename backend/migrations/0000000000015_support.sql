-- Up Migration
CREATE TYPE support_category AS ENUM ('access_payment','technical','service_complaint');
CREATE TABLE support_reviewers (
  reviewer text REFERENCES staff_members, category support_category,
  senior boolean NOT NULL DEFAULT false,
  PRIMARY KEY (reviewer,category), CHECK (category <> 'service_complaint' OR senior)
);
CREATE TABLE support_tickets (
  id uuid PRIMARY KEY, student text NOT NULL REFERENCES "user", category support_category NOT NULL,
  subject text NOT NULL, description text NOT NULL, reported_staff text REFERENCES staff_members,
  assignee text REFERENCES staff_members, escalated boolean NOT NULL DEFAULT false,
  resolved boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (reported_staff IS NULL OR category='service_complaint')
);
CREATE INDEX support_student_queue ON support_tickets(student,updated_at DESC,id);
CREATE TABLE support_events (
  ticket uuid REFERENCES support_tickets, version integer, actor text NOT NULL REFERENCES "user",
  action text NOT NULL CHECK(action IN ('reply','claim','escalate','resolve','reopen')),
  message text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(ticket,version)
);

-- Down Migration
DROP TABLE support_events,support_tickets,support_reviewers;
DROP TYPE support_category;
