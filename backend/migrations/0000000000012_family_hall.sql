-- Up Migration
CREATE TABLE families (
  id uuid PRIMARY KEY,name text NOT NULL,mentor_id text NOT NULL REFERENCES ghazis,
  product_key text NOT NULL,batch_id uuid REFERENCES admission_batches,created_by text NOT NULL REFERENCES staff_members,
  UNIQUE NULLS NOT DISTINCT (mentor_id,product_key,batch_id)
);
CREATE TABLE family_staff (
  family_id uuid NOT NULL REFERENCES families,user_id text NOT NULL REFERENCES staff_members ON DELETE CASCADE,
  PRIMARY KEY(family_id,user_id)
);
CREATE TABLE family_restrictions (
  family_id uuid NOT NULL REFERENCES families,user_id text NOT NULL REFERENCES "user",restricted boolean NOT NULL,
  changed_by text NOT NULL REFERENCES staff_members,changed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(family_id,user_id)
);
CREATE VIEW family_students AS
SELECT f.id AS family_id,e.user_id,e.id AS enrollment_id,g.assigned_at FROM families f
JOIN welcome_enrollments e ON e.product_key=f.product_key AND e.batch_id IS NOT DISTINCT FROM f.batch_id AND e.mentor_id=f.mentor_id
JOIN current_ghazis g ON g.enrollment_id=e.id
WHERE e.route='mentored' AND e.revoked_at IS NULL AND e.starts_at<=now() AND now()<e.mentoring_end AND NOT EXISTS (SELECT FROM family_restrictions x WHERE x.family_id=f.id AND x.user_id=e.user_id AND x.restricted);
CREATE VIEW family_members AS SELECT family_id,user_id FROM family_students UNION SELECT id,mentor_id FROM families;
CREATE TABLE family_presence (
  user_id text PRIMARY KEY REFERENCES "user",last_active timestamptz NOT NULL,sharing boolean NOT NULL,
  focused boolean NOT NULL, activity text,subject text
);
CREATE TABLE family_messages (
  id uuid PRIMARY KEY,family_id uuid NOT NULL REFERENCES families,author text NOT NULL REFERENCES "user",
  body text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX family_message_page ON family_messages(family_id,created_at,id);
CREATE TABLE family_nudges (
  family_id uuid NOT NULL REFERENCES families,sender text NOT NULL REFERENCES "user",recipient text NOT NULL REFERENCES "user",
  sent_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(family_id,sender,recipient),CHECK(sender<>recipient)
);
CREATE TABLE family_goals (
  family_id uuid NOT NULL REFERENCES families,week date NOT NULL,target integer NOT NULL CHECK(target>0),
  title text NOT NULL,version integer NOT NULL CHECK(version>0),PRIMARY KEY(family_id,week)
);
CREATE TABLE family_captains (
  id uuid PRIMARY KEY,family_id uuid NOT NULL REFERENCES families,student_id text NOT NULL REFERENCES "user",
  volunteered_at timestamptz NOT NULL DEFAULT now(),approved_at timestamptz,ends_at timestamptz,stepped_down_at timestamptz
);
CREATE TABLE family_awards (
  id uuid PRIMARY KEY,family_id uuid NOT NULL REFERENCES families,student_id text REFERENCES "user",title text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('achievement','trophy')),awarded_by text NOT NULL REFERENCES staff_members,awarded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE family_events (
  id uuid PRIMARY KEY,home uuid NOT NULL REFERENCES families,away uuid NOT NULL REFERENCES families CHECK(home<>away),
  title text NOT NULL,opens_at timestamptz NOT NULL,closes_at timestamptz NOT NULL CHECK(closes_at>opens_at),
  created_by text NOT NULL REFERENCES "user",ranked_by text REFERENCES staff_members,ranked_at timestamptz,
  home_points integer CHECK(home_points>=0),away_points integer CHECK(away_points>=0),recorded_by text REFERENCES staff_members
);
CREATE TABLE family_entries (
  event_id uuid NOT NULL REFERENCES family_events,user_id text NOT NULL REFERENCES "user",family_id uuid NOT NULL REFERENCES families,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(event_id,user_id)
);

-- Down Migration
DROP VIEW family_members,family_students;
DROP TABLE family_entries,family_events,family_awards,family_captains,family_goals,family_nudges,family_messages,family_presence,family_restrictions,family_staff,families;
