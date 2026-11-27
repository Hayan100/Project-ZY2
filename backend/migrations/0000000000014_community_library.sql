-- Up Migration
CREATE TABLE community_moderators(user_id text PRIMARY KEY REFERENCES staff_members);
CREATE TABLE doubt_staff(user_id text REFERENCES academic_staff,subject text,PRIMARY KEY(user_id,subject));
CREATE TABLE shared_spaces(
 id uuid PRIMARY KEY, name text NOT NULL, kind text NOT NULL CHECK(kind IN('announcements','academic','general','media','resources','quiet','social')),
 product text,batch uuid REFERENCES admission_batches,family uuid REFERENCES families,invitation boolean NOT NULL DEFAULT false,
 subject text,course uuid REFERENCES courses,lesson uuid,stoat_channel text UNIQUE,
 capacity integer CHECK(capacity BETWEEN 1 AND 24), instances integer CHECK(instances BETWEEN 1 AND 16),
 CHECK((course IS NULL)=(lesson IS NULL)),CHECK((kind='academic')=(subject IS NOT NULL)),
 CHECK((kind IN('quiet','social'))=(capacity IS NOT NULL)), CHECK((capacity IS NULL)=(instances IS NULL)),
 CHECK(NOT invitation OR product IS NOT NULL),CHECK(batch IS NULL OR product IS NOT NULL)
);
CREATE TABLE space_follows(space uuid REFERENCES shared_spaces,actor text REFERENCES "user",PRIMARY KEY(space,actor));
CREATE TABLE library_invites(space uuid REFERENCES shared_spaces,instance integer,actor text REFERENCES "user",sender text REFERENCES "user",expires timestamptz NOT NULL,PRIMARY KEY(space,actor));
CREATE TABLE community_blocks(actor text REFERENCES "user",peer text REFERENCES "user",PRIMARY KEY(actor,peer),CHECK(actor<>peer));
CREATE TABLE peer_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sender text REFERENCES "user",recipient text REFERENCES "user",
 accepted boolean NOT NULL DEFAULT false,CHECK(sender<>recipient));
CREATE UNIQUE INDEX peer_pair ON peer_requests(least(sender,recipient),greatest(sender,recipient));
CREATE TABLE community_posts(id uuid PRIMARY KEY,space uuid REFERENCES shared_spaces,dm uuid REFERENCES peer_requests,
 instance integer,parent uuid REFERENCES community_posts,author text NOT NULL REFERENCES "user",body text,remote_id text,
 created timestamptz NOT NULL DEFAULT clock_timestamp(),removed boolean NOT NULL DEFAULT false,verified_by text REFERENCES academic_staff,
 CHECK(num_nonnulls(space,dm)=1),CHECK(num_nonnulls(body,remote_id)=1));
CREATE INDEX community_timeline ON community_posts(space,created,id);
CREATE TABLE library_desks(actor text PRIMARY KEY REFERENCES "user",session_id uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),
 space uuid NOT NULL REFERENCES shared_spaces,instance integer NOT NULL,seen timestamptz NOT NULL DEFAULT clock_timestamp(),
 ebook uuid REFERENCES ebooks,focus_start timestamptz,focus_end timestamptz,course uuid REFERENCES courses,lesson uuid,voice boolean NOT NULL DEFAULT false);
CREATE INDEX library_occupancy ON library_desks(space,instance,seen);
CREATE TABLE library_signals(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,sender uuid NOT NULL,recipient uuid NOT NULL,kind text NOT NULL,body text NOT NULL,created timestamptz NOT NULL DEFAULT now());
CREATE TABLE community_reports(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),reporter text REFERENCES "user",subject text NOT NULL REFERENCES "user",
 post uuid REFERENCES community_posts,space uuid REFERENCES shared_spaces,reason text NOT NULL,created timestamptz NOT NULL DEFAULT now());
CREATE TABLE community_actions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),report uuid UNIQUE REFERENCES community_reports,
 actor text NOT NULL REFERENCES community_moderators,kind text NOT NULL CHECK(kind IN('dismiss','warn','remove','mute','restrict')),reason text NOT NULL,expires timestamptz,
 appeal text,decision text,reviewer text REFERENCES community_moderators,overturned boolean NOT NULL DEFAULT false,created timestamptz NOT NULL DEFAULT now());
CREATE VIEW community_limits AS SELECT r.subject,a.kind FROM community_actions a JOIN community_reports r ON r.id=a.report
 WHERE a.expires>now() AND NOT a.overturned;
CREATE VIEW space_access AS SELECT s.id,u.id AS actor FROM shared_spaces s CROSS JOIN "user" u
 WHERE NOT EXISTS(SELECT FROM community_limits l WHERE l.subject=u.id AND l.kind='restrict')
 AND (s.family IS NULL OR EXISTS(SELECT FROM family_members m WHERE m.family_id=s.family AND m.user_id=u.id))
 AND (s.product IS NULL OR EXISTS(SELECT FROM welcome_enrollments e WHERE e.user_id=u.id AND e.product_key=s.product
 AND (s.batch IS NULL OR s.batch=e.batch_id) AND e.revoked_at IS NULL AND e.starts_at<=now() AND e.ends_at>now())
 OR EXISTS(SELECT FROM families f WHERE f.mentor_id=u.id AND f.product_key=s.product AND (s.batch IS NULL OR s.batch=f.batch_id)))
 AND (NOT s.invitation OR EXISTS(SELECT FROM library_invites i WHERE i.space=s.id AND i.actor=u.id AND i.expires>now() AND NOT EXISTS(SELECT FROM community_blocks WHERE (actor,peer) IN ((i.actor,i.sender),(i.sender,i.actor)))));
CREATE VIEW occupied_desks AS SELECT d.* FROM library_desks d JOIN space_access a ON a.id=d.space AND a.actor=d.actor
 WHERE d.seen>now()-interval '90 seconds' AND NOT EXISTS(SELECT FROM live_focus f WHERE f.player=d.actor);
INSERT INTO shared_spaces(id,name,kind) VALUES(gen_random_uuid(),'Academy announcements','announcements'),(gen_random_uuid(),'Common room','general');

-- Down Migration
DROP VIEW occupied_desks,space_access,community_limits;
DROP TABLE community_actions,community_reports,library_signals,library_desks,community_posts,peer_requests,community_blocks,library_invites,space_follows,shared_spaces,doubt_staff,community_moderators;
