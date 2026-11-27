-- Up Migration
CREATE TABLE resource_reviews (
  post uuid PRIMARY KEY REFERENCES community_posts,
  status text NOT NULL CHECK (status IN ('approved','declined')),
  reviewer text NOT NULL REFERENCES "user",
  version integer NOT NULL CHECK (version > 0)
);
CREATE INDEX resource_channel_posts ON community_posts(space,id);
CREATE VIEW published_resource_posts AS
  SELECT p.id FROM community_posts p JOIN resource_reviews r ON r.post=p.id
  WHERE NOT p.removed AND r.status='approved' AND (p.parent IS NULL OR EXISTS (
    SELECT FROM community_posts parent JOIN resource_reviews pr ON pr.post=parent.id
    WHERE parent.id=p.parent AND NOT parent.removed AND pr.status='approved'
  ));

-- Down Migration
DROP VIEW published_resource_posts;
DROP INDEX resource_channel_posts;
DROP TABLE resource_reviews;
