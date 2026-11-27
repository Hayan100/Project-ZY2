-- Up Migration
CREATE TABLE renewal_offers(product text NOT NULL,offer uuid REFERENCES payment_offers,services text NOT NULL,PRIMARY KEY(product,offer));
CREATE TABLE purchase_cases(id uuid PRIMARY KEY,student text NOT NULL REFERENCES "user",offer uuid NOT NULL REFERENCES payment_offers,
  kind text NOT NULL CHECK(kind IN ('overlap','scholarship')),reason text NOT NULL,requested_at timestamptz NOT NULL DEFAULT now(),
  asked_paisa int,decision text CHECK(decision IN ('approved','declined')),resolved_offer uuid REFERENCES payment_offers,
  explanation text,reviewer text REFERENCES "user",decided_at timestamptz);
CREATE TABLE private_offers(offer uuid PRIMARY KEY REFERENCES payment_offers,student text REFERENCES "user");
-- Down Migration
DROP TABLE private_offers,purchase_cases,renewal_offers;
