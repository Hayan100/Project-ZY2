-- Up Migration
CREATE TABLE refund_cases (
  id uuid PRIMARY KEY,invoice uuid NOT NULL REFERENCES payment_invoices,student text NOT NULL REFERENCES "user",
  reason text NOT NULL,requested_at timestamptz NOT NULL DEFAULT now(),
  decision text CHECK(decision IN ('approved','declined')),amount_paisa int CHECK(amount_paisa>=0),
  explanation text,reviewer text REFERENCES "user",decided_at timestamptz,settlement_reference text,settled_at timestamptz,
  settled_by text REFERENCES "user"
);
CREATE UNIQUE INDEX refund_pending ON refund_cases(invoice) WHERE decision IS NULL;
CREATE UNIQUE INDEX refund_settlement ON refund_cases(settlement_reference) WHERE settlement_reference IS NOT NULL;
-- Down Migration
DROP TABLE refund_cases;
