-- Up Migration
CREATE TABLE marketing_staff(staff text PRIMARY KEY REFERENCES staff_members,approver boolean NOT NULL);
CREATE TABLE admissions_consent(student text PRIMARY KEY REFERENCES "user",allowed boolean NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE admissions_campaigns(id uuid PRIMARY KEY,product text NOT NULL,steps jsonb NOT NULL,author text NOT NULL REFERENCES marketing_staff,
  approved_by text REFERENCES marketing_staff,approved_at timestamptz,CHECK(author IS DISTINCT FROM approved_by));
CREATE TABLE admissions_deliveries(campaign uuid REFERENCES admissions_campaigns,student text REFERENCES "user",step int NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(campaign,student,step));
-- Down Migration
DROP TABLE admissions_deliveries,admissions_campaigns,admissions_consent,marketing_staff;
