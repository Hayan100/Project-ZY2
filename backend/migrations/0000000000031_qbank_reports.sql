-- Up Migration
CREATE TABLE mistake_reflections(student text REFERENCES "user",attempt uuid,question uuid,body text NOT NULL,version int NOT NULL,
  PRIMARY KEY(student,attempt,question,version));
CREATE TABLE question_reports(id uuid PRIMARY KEY,student text REFERENCES "user",question uuid NOT NULL,detail text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),decision text CHECK(decision IN ('resolved','declined')),reply text,reviewer text REFERENCES "user",decided_at timestamptz);
CREATE TABLE comparison_seasons(id uuid PRIMARY KEY,product text NOT NULL,exam text NOT NULL,syllabus text NOT NULL,
  begins timestamptz NOT NULL,ends timestamptz NOT NULL,min_answers int NOT NULL,min_peers int NOT NULL, CHECK(begins<ends));
CREATE TABLE question_activity(student text REFERENCES "user",id uuid,question uuid,started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,PRIMARY KEY(student,id),CHECK(started_at<ended_at));
-- Down Migration
DROP TABLE question_activity,comparison_seasons,question_reports,mistake_reflections;
