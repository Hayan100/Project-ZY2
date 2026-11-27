-- Up Migration
CREATE TABLE personal_decks(student text PRIMARY KEY REFERENCES "user",deck uuid NOT NULL UNIQUE DEFAULT gen_random_uuid());
CREATE TABLE personal_cards(student text REFERENCES personal_decks,card uuid,revision integer,front text NOT NULL,back text NOT NULL,
  PRIMARY KEY(student,card,revision));
CREATE TABLE personal_reviews (LIKE card_reviews INCLUDING ALL);
CREATE TABLE personal_card_creates(student text REFERENCES personal_decks,request uuid,card uuid NOT NULL DEFAULT gen_random_uuid(),PRIMARY KEY(student,request));
CREATE VIEW student_reviews AS SELECT * FROM card_reviews UNION ALL SELECT * FROM personal_reviews;
-- Down Migration
DROP VIEW student_reviews;
DROP TABLE personal_reviews,personal_card_creates,personal_cards,personal_decks;
