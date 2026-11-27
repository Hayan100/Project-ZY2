GRANT SELECT ON academic_staff, courses, course_revisions TO zy2_api;
GRANT INSERT (id,product_key), UPDATE (revision,published_revision) ON courses TO zy2_api;
GRANT INSERT (course_id,revision,outline,authored_by), UPDATE (published_by,published_at) ON course_revisions TO zy2_api;
GRANT SELECT, INSERT, UPDATE (version,position,completed,updated_at) ON lesson_progress TO zy2_api;
