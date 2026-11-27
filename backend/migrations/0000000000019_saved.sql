-- Up Migration
CREATE TABLE stoat_sends(id uuid PRIMARY KEY, digest text NOT NULL);
CREATE TABLE study_bookmarks (
  student text REFERENCES "user", kind text CHECK(kind IN ('lesson','page','sheet')),
  source uuid, target uuid, course uuid, lesson uuid, original_signature text,
  PRIMARY KEY(student,kind,source,target)
);

-- Down Migration
DROP TABLE study_bookmarks,stoat_sends;
