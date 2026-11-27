-- Up Migration
CREATE TABLE premiere_visits (
  student text REFERENCES "user",course uuid REFERENCES courses,lesson uuid,resource uuid,
  opened_at timestamptz,deadline timestamptz NOT NULL,started_at timestamptz NOT NULL DEFAULT now(),
  played int4multirange NOT NULL DEFAULT '{}',
  PRIMARY KEY(student,course,lesson,resource,opened_at)
);
CREATE TABLE replay_requests (
  id uuid PRIMARY KEY,student text NOT NULL REFERENCES "user", course uuid NOT NULL REFERENCES courses,
  lesson uuid NOT NULL,resource uuid NOT NULL,reason text NOT NULL,requested_at timestamptz NOT NULL DEFAULT now(),
  decision text CHECK(decision IN ('approved','declined')), reviewer text REFERENCES "user",
  decided_at timestamptz, expires_at timestamptz
);
CREATE UNIQUE INDEX replay_pending ON replay_requests(student,course,lesson,resource) WHERE decision IS NULL;

-- Down Migration
DROP TABLE replay_requests,premiere_visits;
