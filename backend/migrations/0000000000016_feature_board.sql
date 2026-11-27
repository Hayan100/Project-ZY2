-- Up Migration
CREATE TABLE feature_suggestions (
  id uuid PRIMARY KEY,
  author text NOT NULL REFERENCES "user",
  title text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','under_review','planned','in_progress','delivered','declined')),
  version integer NOT NULL DEFAULT 0,
  reviewed_by text REFERENCES "user"
);
CREATE TABLE feature_votes (
  suggestion uuid REFERENCES feature_suggestions,
  voter text REFERENCES "user",
  PRIMARY KEY (suggestion,voter)
);

-- Down Migration
DROP TABLE feature_votes,feature_suggestions;
