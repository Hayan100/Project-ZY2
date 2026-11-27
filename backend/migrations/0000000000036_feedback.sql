-- Up Migration
ALTER TABLE support_tickets ADD COLUMN opened_at timestamptz;
UPDATE support_tickets t SET opened_at=least(t.updated_at,(SELECT min(created_at) FROM support_events WHERE ticket=t.id));
ALTER TABLE support_tickets ALTER opened_at SET NOT NULL,ALTER opened_at SET DEFAULT now();
CREATE TABLE support_targets(category support_category PRIMARY KEY,ack_minutes int NOT NULL,resolve_minutes int NOT NULL);
CREATE TABLE feedback_leads(staff text PRIMARY KEY REFERENCES staff_members);
CREATE TABLE feedback_surveys(id uuid PRIMARY KEY,batch uuid REFERENCES admission_batches,title text NOT NULL,
  questions jsonb NOT NULL,opens timestamptz NOT NULL,period_days int NOT NULL,min_group int NOT NULL,subject_staff text REFERENCES staff_members,
  reviewer text NOT NULL REFERENCES staff_members,author text NOT NULL REFERENCES feedback_leads,CHECK(reviewer IS DISTINCT FROM subject_staff));
CREATE TABLE feedback_responses(survey uuid REFERENCES feedback_surveys,period int,student text REFERENCES "user",ratings jsonb NOT NULL,
  comment text NOT NULL,at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(survey,period,student));
CREATE TABLE feedback_actions(id uuid PRIMARY KEY,survey uuid REFERENCES feedback_surveys,actor text REFERENCES feedback_leads,body text NOT NULL,
  at timestamptz NOT NULL DEFAULT now());
-- Down Migration
DROP TABLE feedback_actions,feedback_responses,feedback_surveys,feedback_leads,support_targets;
ALTER TABLE support_tickets DROP COLUMN opened_at;
