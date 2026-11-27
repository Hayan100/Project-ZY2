-- Up Migration
CREATE TABLE page_ink(student text REFERENCES "user",id uuid,version int,book uuid NOT NULL,page uuid NOT NULL,
  revision int NOT NULL,points jsonb NOT NULL,PRIMARY KEY(student,id,version),FOREIGN KEY(book,revision) REFERENCES ebook_revisions);
CREATE INDEX page_ink_book ON page_ink(student,book,page);
-- Down Migration
DROP TABLE page_ink;
