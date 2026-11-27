-- Up Migration
CREATE TABLE welcome_admins (user_id text PRIMARY KEY REFERENCES staff_members ON DELETE CASCADE);
CREATE TABLE welcome_products (
  product_key text PRIMARY KEY, route text NOT NULL CHECK(route IN ('mentored','self_paced','test_only')),
  planner_threshold integer CHECK(planner_threshold>0),revision_threshold integer CHECK(revision_threshold>0),
  checkin_days integer NOT NULL DEFAULT 7 CHECK(checkin_days BETWEEN 1 AND 365)
);
CREATE TABLE ghazis (
  user_id text PRIMARY KEY REFERENCES staff_members, priority integer NOT NULL CHECK(priority>0),
  capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 100), available boolean NOT NULL,
  experience text NOT NULL,working_hours text NOT NULL,reply_minutes integer NOT NULL CHECK(reply_minutes>0)
);
CREATE TABLE welcome_templates (
  scope text NOT NULL,revision integer NOT NULL,questions jsonb NOT NULL,author text NOT NULL REFERENCES "user",
  PRIMARY KEY(scope,revision)
);
CREATE TABLE welcome_profiles(student_id text PRIMARY KEY REFERENCES "user",confirmed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE welcome_intakes (
  enrollment_id uuid PRIMARY KEY REFERENCES enrollments,scope text NOT NULL,template_revision integer NOT NULL,
  questions jsonb NOT NULL,answers jsonb NOT NULL,version integer NOT NULL,submitted_at timestamptz
);
CREATE TABLE ghazi_assignments (
  enrollment_id uuid NOT NULL REFERENCES enrollments,version integer NOT NULL,mentor_id text NOT NULL REFERENCES ghazis,
  assigned_by text NOT NULL REFERENCES "user",assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  override_reason text, PRIMARY KEY(enrollment_id,version)
);
CREATE VIEW current_ghazis AS SELECT DISTINCT ON(enrollment_id) * FROM ghazi_assignments ORDER BY enrollment_id,version DESC;
CREATE TABLE welcome_terms(enrollment_id uuid PRIMARY KEY REFERENCES enrollments,ends_at timestamptz NOT NULL,changed_by text NOT NULL REFERENCES "user");
CREATE VIEW welcome_enrollments AS SELECT e.id,e.user_id,e.product_key,e.starts_at,e.ends_at,e.revoked_at,o.batch_id,
  coalesce(p.route,CASE WHEN o.batch_id IS NULL THEN 'self_paced' ELSE 'mentored' END) AS route,
  p.planner_threshold,p.revision_threshold,coalesce(t.ends_at,e.ends_at) AS mentoring_end,coalesce(p.checkin_days,7) AS checkin_days,
  g.mentor_id,coalesce(g.version,0) AS assignment_version
  FROM enrollments e LEFT JOIN payment_receipts r ON r.enrollment_id=e.id AND r.part=1
  LEFT JOIN payment_invoices i ON i.id=r.invoice_id LEFT JOIN payment_offers o ON o.id=i.offer_id
  LEFT JOIN welcome_products p ON p.product_key=e.product_key LEFT JOIN welcome_terms t ON t.enrollment_id=e.id
  LEFT JOIN current_ghazis g ON g.enrollment_id=e.id;
ALTER TABLE revision_mentors ADD COLUMN managed boolean NOT NULL DEFAULT false;
CREATE VIEW active_mentors AS SELECT m.* FROM revision_mentors m WHERE NOT m.managed OR EXISTS (
  SELECT FROM welcome_enrollments e WHERE e.user_id=m.student_id AND e.mentor_id=m.mentor_id AND e.route='mentored'
  AND e.revoked_at IS NULL AND e.mentoring_end>now());
CREATE TABLE welcome_slots (
  id uuid PRIMARY KEY,mentor_id text NOT NULL REFERENCES ghazis,starts_at timestamptz NOT NULL,
  minutes integer NOT NULL CHECK(minutes BETWEEN 5 AND 180),gap integer NOT NULL CHECK(gap BETWEEN 0 AND 60)
);
CREATE INDEX welcome_slot_time ON welcome_slots(mentor_id,starts_at);
CREATE TABLE welcome_bookings (
  enrollment_id uuid PRIMARY KEY REFERENCES enrollments,slot_id uuid UNIQUE REFERENCES welcome_slots,
  mode text NOT NULL CHECK(mode IN ('voice','video','scheduled_chat','async_chat','request_time','cancelled')),
  version integer NOT NULL,preference text,changed_by text NOT NULL REFERENCES "user",updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((slot_id IS NOT NULL)=(mode IN ('voice','video','scheduled_chat')))
);
CREATE TABLE welcome_cover(enrollment_id uuid PRIMARY KEY REFERENCES enrollments,mentor_id text NOT NULL REFERENCES ghazis,until_at timestamptz NOT NULL);
CREATE TABLE ghazi_messages (
  id uuid PRIMARY KEY,enrollment_id uuid NOT NULL,assignment_version integer NOT NULL,author text NOT NULL REFERENCES "user",
  welcome_mentor text REFERENCES ghazis,body text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(enrollment_id,assignment_version) REFERENCES ghazi_assignments
);
CREATE INDEX ghazi_messages_case ON ghazi_messages(enrollment_id,created_at,id);
CREATE TABLE ghazi_history_grants (
  enrollment_id uuid NOT NULL,assignment_version integer NOT NULL,reader text NOT NULL REFERENCES staff_members,
  until_at timestamptz NOT NULL,granted_by text NOT NULL REFERENCES "user",PRIMARY KEY(enrollment_id,assignment_version,reader),
  FOREIGN KEY(enrollment_id,assignment_version) REFERENCES ghazi_assignments
);
CREATE TABLE ghazi_access_log (
  enrollment_id uuid NOT NULL REFERENCES enrollments,actor text NOT NULL REFERENCES "user",action text NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE ghazi_followups (
  id uuid PRIMARY KEY,enrollment_id uuid NOT NULL,assignment_version integer NOT NULL,author text NOT NULL REFERENCES "user",
  strengths text NOT NULL,priorities text NOT NULL,first_week text NOT NULL,next_checkin timestamptz NOT NULL,
  excused_until timestamptz,private_note text NOT NULL,status text NOT NULL CHECK(status IN ('follow_up','resolved','escalated')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(enrollment_id,assignment_version) REFERENCES ghazi_assignments
);

CREATE TABLE welcome_resources (
  enrollment_id uuid NOT NULL REFERENCES enrollments,course_id uuid NOT NULL,lesson_id uuid NOT NULL,revision integer NOT NULL,
  diagnostic boolean NOT NULL,selected_by text NOT NULL REFERENCES "user",PRIMARY KEY(enrollment_id,course_id,lesson_id),
  FOREIGN KEY(course_id,revision) REFERENCES course_revisions
);
CREATE VIEW available_welcome_resources AS SELECT p.*,e.user_id FROM welcome_resources p JOIN welcome_enrollments e ON e.id=p.enrollment_id
  JOIN courses c ON c.id=p.course_id AND c.product_key=e.product_key AND c.published_revision=p.revision
  WHERE e.revoked_at IS NULL AND e.starts_at>now() AND e.route='mentored' AND e.mentoring_end>now();
CREATE TABLE ghazi_duty (mentor_id text PRIMARY KEY REFERENCES ghazis,on_duty boolean NOT NULL,last_active timestamptz NOT NULL);
CREATE TABLE ghazi_supervision(enrollment_id uuid NOT NULL REFERENCES enrollments,supervisor_id text NOT NULL REFERENCES staff_members,
  until_at timestamptz NOT NULL,granted_by text NOT NULL REFERENCES "user",PRIMARY KEY(enrollment_id,supervisor_id));
CREATE VIEW ghazi_waits AS SELECT e.id,e.mentor_id,p.reply_minutes,waiting.since,
  waiting.since+make_interval(mins=>p.reply_minutes)<=now() AS overdue FROM welcome_enrollments e JOIN ghazis p ON p.user_id=e.mentor_id
  CROSS JOIN LATERAL (SELECT min(m.created_at) AS since FROM ghazi_messages m WHERE m.enrollment_id=e.id AND m.assignment_version=e.assignment_version
  AND m.welcome_mentor IS NULL AND m.author=e.user_id AND m.created_at>coalesce((SELECT max(r.created_at) FROM ghazi_messages r
  WHERE r.enrollment_id=e.id AND r.assignment_version=e.assignment_version AND r.welcome_mentor IS NULL AND r.author=e.mentor_id),'-infinity')) waiting
  WHERE e.revoked_at IS NULL AND e.route='mentored' AND e.mentoring_end>now() AND waiting.since IS NOT NULL;
ALTER TABLE quiz_attempts ADD COLUMN diagnostic_enrollment_id uuid REFERENCES enrollments;

-- Down Migration
ALTER TABLE quiz_attempts DROP COLUMN diagnostic_enrollment_id;
DROP VIEW ghazi_waits;
DROP TABLE ghazi_supervision,ghazi_duty;
DROP VIEW available_welcome_resources;
DROP TABLE welcome_resources;
DROP VIEW active_mentors,welcome_enrollments,current_ghazis;
ALTER TABLE revision_mentors DROP COLUMN managed;
DROP TABLE ghazi_followups,ghazi_access_log,ghazi_history_grants,ghazi_messages,welcome_cover,welcome_bookings,welcome_slots,welcome_terms,
  ghazi_assignments,welcome_intakes,welcome_profiles,welcome_templates,ghazis,welcome_products,welcome_admins;
