-- Up Migration
CREATE TABLE lesson_progress (
  user_id text NOT NULL REFERENCES "user",
  course_id uuid NOT NULL REFERENCES courses,
  lesson_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  lesson_type text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  position jsonb NOT NULL,
  completed boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id,course_id,lesson_id,resource_id,lesson_type)
);

-- Down Migration
DROP TABLE lesson_progress;
