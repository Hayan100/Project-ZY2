-- Up Migration
CREATE TABLE sample_materials(id uuid PRIMARY KEY,kind text NOT NULL,source uuid NOT NULL,revision int NOT NULL,
  target uuid NOT NULL,title text NOT NULL,enabled boolean NOT NULL,author text REFERENCES "user",UNIQUE(kind,source,revision,target));
CREATE TABLE sample_practice(student text REFERENCES "user",sample uuid REFERENCES sample_materials,choice uuid NOT NULL,PRIMARY KEY(student,sample));
-- Down Migration
DROP TABLE sample_practice,sample_materials;
