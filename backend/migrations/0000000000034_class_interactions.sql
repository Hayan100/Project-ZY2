-- Up Migration
CREATE TABLE class_posts(id uuid PRIMARY KEY,class uuid REFERENCES classes,student text REFERENCES "user",kind text NOT NULL,
  body text NOT NULL,submitted timestamptz NOT NULL DEFAULT now(),approved boolean,reply text,reviewer text REFERENCES "user");
CREATE TABLE class_polls(id uuid PRIMARY KEY,class uuid REFERENCES classes,title text NOT NULL,choices jsonb NOT NULL,author text REFERENCES "user",
  closes timestamptz NOT NULL);
CREATE TABLE class_votes(poll uuid REFERENCES class_polls,student text REFERENCES "user",choice int NOT NULL,PRIMARY KEY(poll,student));
-- Down Migration
DROP TABLE class_votes,class_polls,class_posts;
