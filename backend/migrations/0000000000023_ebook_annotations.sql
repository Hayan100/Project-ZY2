-- Up Migration
CREATE TABLE ebook_annotations (
  student text REFERENCES "user",id uuid,book uuid,page uuid,revision integer NOT NULL,
  start_offset integer NOT NULL,end_offset integer NOT NULL,body text NOT NULL,version integer NOT NULL,
  PRIMARY KEY(student,id,version),FOREIGN KEY(book,revision) REFERENCES ebook_revisions(book_id,revision)
);
CREATE INDEX ebook_annotation_pages ON ebook_annotations(student,book,page);
-- Down Migration
DROP TABLE ebook_annotations;
