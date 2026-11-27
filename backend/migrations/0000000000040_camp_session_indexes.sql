-- Up Migration
CREATE INDEX formal_registrations_student_event ON formal_registrations(student,event);
CREATE INDEX classes_closes ON classes(closes);

-- Down Migration
DROP INDEX classes_closes;
DROP INDEX formal_registrations_student_event;
