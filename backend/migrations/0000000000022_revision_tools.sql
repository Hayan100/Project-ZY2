-- Up Migration
ALTER TABLE personal_notes ADD COLUMN subject text NOT NULL DEFAULT '', ADD COLUMN topic text NOT NULL DEFAULT '';
CREATE TABLE personal_note_versions (
  student_id text NOT NULL,id uuid NOT NULL,version integer NOT NULL,title text NOT NULL,body text NOT NULL,
  subject text NOT NULL,topic text NOT NULL,PRIMARY KEY(student_id,id,version),
  FOREIGN KEY(student_id,id) REFERENCES personal_notes
);
INSERT INTO personal_note_versions SELECT student_id,id,version,title,body,subject,topic FROM personal_notes;
CREATE FUNCTION keep_personal_note_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO personal_note_versions VALUES (NEW.student_id,NEW.id,NEW.version,NEW.title,NEW.body,NEW.subject,NEW.topic);
  RETURN NEW;
END $$;
CREATE TRIGGER note_history AFTER INSERT OR UPDATE ON personal_notes FOR EACH ROW EXECUTE FUNCTION keep_personal_note_version();
CREATE TABLE marked_questions (
  student text REFERENCES "user",question uuid, PRIMARY KEY(student,question)
);
CREATE TABLE attempt_flags (
  attempt uuid REFERENCES quiz_attempts,question uuid,PRIMARY KEY(attempt,question)
);

-- Down Migration
DROP TABLE attempt_flags,marked_questions;
DROP TRIGGER note_history ON personal_notes;
DROP FUNCTION keep_personal_note_version();
DROP TABLE personal_note_versions;
ALTER TABLE personal_notes DROP COLUMN subject,DROP COLUMN topic;
