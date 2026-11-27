-- Up Migration
CREATE TABLE custom_practice (
  id uuid PRIMARY KEY,student text NOT NULL REFERENCES "user",mode text NOT NULL CHECK(mode IN ('tutor','timed')),
  request jsonb NOT NULL,questions jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),deadline timestamptz,
  submitted_at timestamptz,answers jsonb NOT NULL DEFAULT '{}',version integer NOT NULL DEFAULT 0
);
CREATE INDEX custom_practice_student ON custom_practice(student,created_at);
CREATE VIEW individual_question_history AS
  SELECT a.student_id,r.question_id,r.option_id,r.correct,r.recorded_at,a.id AS attempt,'lesson'::text AS source
  FROM quiz_responses r JOIN quiz_attempts a ON a.id=r.attempt_id
  UNION ALL SELECT d.*,NULL::uuid,'duel' FROM live_duel_responses d
  UNION ALL SELECT a.student,(q->>'id')::uuid,(a.answers->(q->>'id')->>'choice')::uuid,
    (a.answers->(q->>'id')->>'choice')=(q->>'correctOptionId'),
    CASE WHEN a.mode='tutor' THEN coalesce((a.answers->(q->>'id')->>'at')::timestamptz,a.submitted_at)
      ELSE coalesce(a.submitted_at,a.deadline) END,a.id,'custom'
    FROM custom_practice a CROSS JOIN LATERAL jsonb_array_elements(a.questions) q
    WHERE a.submitted_at IS NOT NULL OR a.deadline<=now() OR a.mode='tutor' AND a.answers ? (q->>'id');
CREATE VIEW assessment_focus AS SELECT player FROM live_focus UNION ALL SELECT r.student FROM formal_attempts a
  JOIN formal_registrations r ON r.id=a.registration WHERE NOT a.superseded AND a.submitted_at IS NULL
    AND now()<CASE WHEN a.paused_at IS NULL THEN a.deadline ELSE a.hard_close END;
-- Down Migration
DROP VIEW assessment_focus,individual_question_history;
DROP TABLE custom_practice;
