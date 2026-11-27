-- Up Migration
CREATE TABLE live_papers (
  id uuid PRIMARY KEY, product_key text NOT NULL, mode text NOT NULL CHECK(mode IN ('duel','battle')),
  quiz jsonb NOT NULL, seconds integer NOT NULL CHECK(seconds BETWEEN 30 AND 7200), author text NOT NULL REFERENCES staff_members
);
CREATE TABLE live_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), paper uuid NOT NULL REFERENCES live_papers,
  event uuid UNIQUE REFERENCES family_events, creator text NOT NULL REFERENCES "user",
  question_ids uuid[], lobby_until timestamptz NOT NULL, started timestamptz, deadline timestamptz
);
CREATE UNIQUE INDEX live_battle_paper ON live_rooms(paper) WHERE event IS NOT NULL;
CREATE TABLE live_sides (
  room uuid REFERENCES live_rooms, side integer CHECK(side IN (1,2)), family uuid REFERENCES families,
  captain text NOT NULL REFERENCES "user", deputy text REFERENCES "user", controller text NOT NULL REFERENCES "user",
  answers jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 0, submitted timestamptz,
  PRIMARY KEY(room,side), CHECK(captain<>deputy)
);
CREATE TABLE live_players (
  room uuid NOT NULL, side integer NOT NULL, player text NOT NULL REFERENCES "user", ready boolean NOT NULL DEFAULT false,
  board_question uuid, board_phase text CHECK(board_phase IN ('thinking','selecting','raised')),
  board_version integer NOT NULL DEFAULT 0, board_at timestamptz, seen timestamptz, votes jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(room,player), FOREIGN KEY(room,side) REFERENCES live_sides
);
CREATE INDEX live_player_rooms ON live_players(player,room);
CREATE TABLE live_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, room uuid NOT NULL, side integer NOT NULL,
  sender text NOT NULL, recipient text, kind text NOT NULL CHECK(kind IN ('text','offer','answer','ice')), body text NOT NULL,
  FOREIGN KEY(room,side) REFERENCES live_sides, FOREIGN KEY(room,sender) REFERENCES live_players(room,player),
  FOREIGN KEY(room,recipient) REFERENCES live_players(room,player)
);
CREATE INDEX live_message_page ON live_messages(room,side,id);
CREATE VIEW live_focus AS SELECT p.player FROM live_players p JOIN live_rooms r ON r.id=p.room
  WHERE r.deadline>now() AND EXISTS(SELECT FROM live_sides s WHERE s.room=r.id AND s.submitted IS NULL);
CREATE VIEW live_scores AS SELECT s.room,s.side,s.family,
  (SELECT count(*)::int FROM jsonb_array_elements(p.quiz->'questions') q WHERE s.answers->>(q->>'id')=q->>'correctOptionId' AND (r.question_ids IS NULL OR (q->>'id')::uuid=ANY(r.question_ids))) AS score,
  coalesce(s.submitted,r.deadline)-r.started AS elapsed
  FROM live_sides s JOIN live_rooms r ON r.id=s.room JOIN live_papers p ON p.id=r.paper
  WHERE r.deadline<=statement_timestamp() OR (r.started IS NOT NULL AND NOT EXISTS(SELECT FROM live_sides other WHERE other.room=r.id AND other.submitted IS NULL));

CREATE VIEW live_duel_responses AS
  SELECT p.player AS student_id,(q->>'id')::uuid AS question_id,(s.answers->>(q->>'id'))::uuid AS option_id,
    s.answers->>(q->>'id')=q->>'correctOptionId' AS correct,coalesce(s.submitted,r.deadline) AS recorded_at
  FROM live_players p JOIN live_sides s USING(room,side) JOIN live_rooms r ON r.id=p.room JOIN live_papers b ON b.id=r.paper
  CROSS JOIN LATERAL jsonb_array_elements(b.quiz->'questions') q
  WHERE (r.question_ids IS NULL OR (q->>'id')::uuid=ANY(r.question_ids)) AND r.event IS NULL AND r.started IS NOT NULL AND (r.deadline<=statement_timestamp() OR NOT EXISTS(
    SELECT FROM live_sides other WHERE other.room=r.id AND other.submitted IS NULL));

-- Down Migration
DROP VIEW live_duel_responses;
DROP VIEW live_scores,live_focus;
DROP TABLE live_messages,live_players,live_sides,live_rooms,live_papers;
