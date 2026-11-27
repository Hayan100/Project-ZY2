-- Up Migration
CREATE TABLE academy_sheets (
  id uuid PRIMARY KEY, title text NOT NULL, body text NOT NULL,
  author text NOT NULL REFERENCES "user"
);
CREATE TABLE inventory_saves (
  student text REFERENCES "user", post uuid REFERENCES community_posts,
  PRIMARY KEY(student,post)
);

-- Down Migration
DROP TABLE inventory_saves,academy_sheets;
