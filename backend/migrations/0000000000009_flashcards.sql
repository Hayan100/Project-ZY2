-- Up Migration
CREATE TABLE deck_revisions (
  deck_id uuid NOT NULL, revision integer NOT NULL CHECK (revision>0),
  deck jsonb NOT NULL, authored_by text NOT NULL REFERENCES "user", authored_at timestamptz NOT NULL DEFAULT now(),
  published_by text REFERENCES "user", published_at timestamptz, reset_cards uuid[] NOT NULL DEFAULT '{}',
  PRIMARY KEY(deck_id,revision), CHECK ((published_by IS NULL)=(published_at IS NULL))
);
CREATE VIEW published_decks AS SELECT DISTINCT ON(deck_id) deck_id,revision,deck
  FROM deck_revisions WHERE published_at IS NOT NULL ORDER BY deck_id,revision DESC;
CREATE TABLE academy_cards (
  card_id uuid PRIMARY KEY, owner_deck uuid NOT NULL, revision integer NOT NULL, reset_revision integer NOT NULL DEFAULT 0,
  front text NOT NULL, back text NOT NULL, FOREIGN KEY(owner_deck,revision) REFERENCES deck_revisions
);
CREATE TABLE revision_mentors (
  student_id text NOT NULL REFERENCES "user", mentor_id text NOT NULL REFERENCES staff_members ON DELETE CASCADE,
  suggested_minutes integer CHECK(suggested_minutes BETWEEN 1 AND 1440),
  PRIMARY KEY(student_id,mentor_id)
);
CREATE TABLE deck_activations (
  student_id text NOT NULL REFERENCES "user", deck_id uuid NOT NULL, revision integer NOT NULL,
  activated_by text NOT NULL REFERENCES "user", activated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(student_id,deck_id), FOREIGN KEY(deck_id,revision) REFERENCES deck_revisions
);
CREATE TABLE revision_budgets (
  student_id text PRIMARY KEY REFERENCES "user", minutes integer NOT NULL CHECK(minutes BETWEEN 1 AND 1440)
);
CREATE TABLE card_reviews (
  student_id text NOT NULL REFERENCES "user", event_id uuid NOT NULL, deck_id uuid NOT NULL, card_id uuid NOT NULL,
  revision integer NOT NULL, card_revision integer NOT NULL, version integer NOT NULL CHECK(version>0), rating text NOT NULL CHECK(rating IN ('Again','Hard','Good','Easy')),
  reviewed_at timestamptz NOT NULL, introduced boolean NOT NULL, schedule jsonb NOT NULL, due_at timestamptz NOT NULL,
  PRIMARY KEY(student_id,event_id), UNIQUE(student_id,card_id,version),
  FOREIGN KEY(deck_id,revision) REFERENCES deck_revisions
);
CREATE INDEX card_reviews_day ON card_reviews(student_id,reviewed_at);

-- Down Migration
DROP VIEW published_decks;
DROP TABLE card_reviews, revision_budgets, deck_activations, revision_mentors, academy_cards, deck_revisions;
