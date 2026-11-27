-- Up Migration
CREATE TABLE personal_notes (
  student_id text REFERENCES "user", id uuid, version integer NOT NULL DEFAULT 1,
  title text NOT NULL, body text NOT NULL, PRIMARY KEY (student_id,id)
);

-- Down Migration
DROP TABLE personal_notes;
