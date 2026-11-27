-- Up Migration
ALTER TABLE classes ADD COLUMN youtube_video_id text CHECK (
  youtube_video_id IS NULL OR (kind='broadcast' AND youtube_video_id ~ '^[A-Za-z0-9_-]{11}$')
);
ALTER TABLE classes ADD COLUMN youtube_state text CHECK (youtube_state IN ('live','private'));
CREATE UNIQUE INDEX classes_youtube_video ON classes(youtube_video_id) WHERE youtube_video_id IS NOT NULL;
CREATE TABLE classroom_identity (
  student text PRIMARY KEY REFERENCES "user" ON DELETE CASCADE,
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$')
);
CREATE TABLE classroom_network (
  session_id text PRIMARY KEY REFERENCES session ON DELETE CASCADE,
  last_network text NOT NULL, prior_network text, seen timestamptz NOT NULL,
  prior_seen timestamptz, flagged_at timestamptz
);
-- Down Migration
DROP TABLE classroom_network,classroom_identity;
ALTER TABLE classes DROP COLUMN youtube_state;
ALTER TABLE classes DROP COLUMN youtube_video_id;
