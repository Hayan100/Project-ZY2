-- Up Migration
CREATE TABLE ebooks (
  id uuid PRIMARY KEY,
  library_product_key text CHECK (length(library_product_key) BETWEEN 1 AND 120),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  published_revision integer CHECK (published_revision BETWEEN 1 AND revision)
);
CREATE TABLE ebook_revisions (
  book_id uuid NOT NULL REFERENCES ebooks,
  revision integer NOT NULL,
  manuscript jsonb NOT NULL,
  authored_by text NOT NULL REFERENCES "user",
  authored_at timestamptz NOT NULL DEFAULT now(),
  published_by text REFERENCES "user",
  published_at timestamptz,
  PRIMARY KEY (book_id,revision)
);
ALTER TABLE ebooks ADD FOREIGN KEY (id,revision) REFERENCES ebook_revisions DEFERRABLE INITIALLY DEFERRED,
  ADD FOREIGN KEY (id,published_revision) REFERENCES ebook_revisions DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE ebook_reading (
  user_id text NOT NULL REFERENCES "user",
  book_id uuid NOT NULL REFERENCES ebooks,
  page_id uuid NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  studied boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id,book_id,page_id)
);

-- Down Migration
DROP TABLE ebook_reading, ebook_revisions, ebooks;
