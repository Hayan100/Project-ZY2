-- Up Migration
CREATE TABLE academic_staff (
  user_id text PRIMARY KEY REFERENCES staff_members ON DELETE CASCADE
);
CREATE TABLE courses (
  id uuid PRIMARY KEY,
  product_key text NOT NULL CHECK (length(product_key) BETWEEN 1 AND 120),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  published_revision integer CHECK (published_revision BETWEEN 1 AND revision)
);
CREATE TABLE course_revisions (
  course_id uuid NOT NULL REFERENCES courses,
  revision integer NOT NULL CHECK (revision > 0),
  outline jsonb NOT NULL,
  authored_by text NOT NULL REFERENCES "user",
  authored_at timestamptz NOT NULL DEFAULT now(),
  published_by text REFERENCES "user",
  published_at timestamptz,
  PRIMARY KEY (course_id,revision),
  CHECK ((published_at IS NULL) = (published_by IS NULL))
);
ALTER TABLE courses ADD FOREIGN KEY (id,revision) REFERENCES course_revisions DEFERRABLE INITIALLY DEFERRED,
  ADD FOREIGN KEY (id,published_revision) REFERENCES course_revisions DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX courses_published_product ON courses(product_key) WHERE published_revision IS NOT NULL;

-- Down Migration
DROP TABLE course_revisions, courses, academic_staff;
