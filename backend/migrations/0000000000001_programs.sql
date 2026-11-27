-- Up Migration
CREATE TABLE programs (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  published boolean NOT NULL DEFAULT false
);

INSERT INTO programs (code, name, published)
VALUES ('mdcat', 'MDCAT', true), ('nums', 'NUMS', true);

CREATE VIEW public_programs WITH (security_barrier = true) AS
SELECT code, name FROM programs WHERE published;

-- Down Migration
DROP VIEW public_programs;
DROP TABLE programs;
