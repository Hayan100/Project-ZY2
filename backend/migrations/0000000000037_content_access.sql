-- Up Migration
CREATE TABLE content_security_staff(staff text PRIMARY KEY REFERENCES staff_members);
CREATE TABLE content_policy(product text PRIMARY KEY,grace_seconds integer NOT NULL,short_seconds integer NOT NULL,long_seconds integer NOT NULL,
  short_max integer NOT NULL,long_max integer NOT NULL,hold_seconds integer NOT NULL);
CREATE TABLE content_deliveries(student text NOT NULL REFERENCES "user",product text NOT NULL,kind text NOT NULL,
  resource text NOT NULL,delivered_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX content_evidence ON content_deliveries(student,product,delivered_at);
CREATE TABLE content_alerts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),student text REFERENCES "user",product text NOT NULL,
  short_count int NOT NULL,long_count int NOT NULL,flagged_at timestamptz NOT NULL DEFAULT now(),hold_until timestamptz NOT NULL,
  reviewer text REFERENCES "user",decision text,reviewed_at timestamptz);
CREATE INDEX content_holds ON content_alerts(student,product,hold_until);
-- Down Migration
DROP TABLE content_alerts,content_deliveries,content_policy,content_security_staff;
