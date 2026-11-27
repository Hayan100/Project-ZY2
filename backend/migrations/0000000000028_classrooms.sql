-- Up Migration
CREATE TABLE classes(id uuid PRIMARY KEY,product text NOT NULL,batch uuid REFERENCES admission_batches,
  title text NOT NULL,kind text NOT NULL,opens timestamptz NOT NULL,closes timestamptz NOT NULL,author text REFERENCES "user",
  replay text, CHECK(opens<closes));
CREATE TABLE class_presence(class uuid REFERENCES classes,student text REFERENCES "user",seen tstzmultirange NOT NULL DEFAULT '{}',
  last_seen timestamptz NOT NULL,PRIMARY KEY(class,student));
CREATE TABLE class_attendance_edits(id uuid PRIMARY KEY,class uuid REFERENCES classes,student text REFERENCES "user",seconds integer NOT NULL,
  reason text NOT NULL,reviewer text REFERENCES "user",at timestamptz NOT NULL DEFAULT now());
CREATE TABLE class_replay_views(class uuid REFERENCES classes,student text REFERENCES "user",first_open timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(class,student));
CREATE TABLE class_extensions(class uuid REFERENCES classes,student text REFERENCES "user",expires timestamptz NOT NULL,
  reviewer text REFERENCES "user",reason text NOT NULL,PRIMARY KEY(class,student));
-- Down Migration
DROP TABLE class_extensions,class_replay_views,class_attendance_edits,class_presence,classes;
