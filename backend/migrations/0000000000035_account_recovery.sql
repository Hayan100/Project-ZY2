-- Up Migration
CREATE TABLE recovery_staff(staff text PRIMARY KEY REFERENCES staff_members);
CREATE TABLE recovery_decisions(id uuid PRIMARY KEY,student text NOT NULL REFERENCES "user",reviewer text NOT NULL REFERENCES recovery_staff,
  evidence text NOT NULL,decision text NOT NULL CHECK(decision IN ('approved','declined')),decided_at timestamptz NOT NULL DEFAULT now(),
  lease uuid,lease_until timestamptz,sent_at timestamptz);
-- Down Migration
DROP TABLE recovery_decisions,recovery_staff;
