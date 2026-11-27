-- Up Migration
CREATE TABLE ai_allowances(product text PRIMARY KEY,questions int NOT NULL CHECK(questions>0),period_days int NOT NULL CHECK(period_days>0));
CREATE TABLE ai_requests (
  student text REFERENCES "user",id uuid,product text NOT NULL,period_start date NOT NULL,source jsonb NOT NULL,
  question text NOT NULL,source_hash text NOT NULL,answer text,lease uuid NOT NULL,lease_until timestamptz NOT NULL,PRIMARY KEY(student,id)
);
CREATE INDEX ai_usage ON ai_requests(student,product,period_start);
-- Down Migration
DROP TABLE ai_requests,ai_allowances;
