import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { fail, sessionTransaction, type Identity } from "./authorized.ts";

type Lesson = { id: string; title: string; type: string; resourceId?: string; relatedResourceIds?: string[] };
type Outline = {
  title: string; examYear?: number; provinces?: string[];
  chapters: { id: string; title: string; lessons: Lesson[] }[];
};
type Course = { Params: { id: string } };
const uuid = { type: "string", format: "uuid", pattern: "^[0-9a-f-]+$" };
const title = { type: "string", maxLength: 200, pattern: "\\S" };
const revision = { type: "integer", minimum: 1, maximum: 2147483647 };
const object = (properties: Record<string, object>, required = Object.keys(properties)) =>
  ({ type: "object", properties, required, additionalProperties: false });
const array = (items: object, maxItems: number) => ({ type: "array", items, maxItems });
const params = object({ id: uuid });
const lesson = object({ id: uuid, title, type: { enum: ["video","html_article","mcq_quiz","flashcard_review"] },
  resourceId: uuid, relatedResourceIds: { ...array(uuid, 64), uniqueItems: true } }, ["id","title","type"]);
const chapter = object({ id: uuid, title, lessons: array(lesson, 500) });
const outlineSchema = object({ title, chapters: array(chapter, 200), examYear: { type: "integer", minimum: 2000, maximum: 9999 },
  provinces: { ...array(title, 32), uniqueItems: true } }, ["title","chapters"]);
const bodyLimit = 1024 * 1024;

async function saveRevision(tx: PoolClient, id: string, version: number, outline: Outline, author: string) {
  const ids = outline.chapters.flatMap(ch => [ch.id, ...ch.lessons.map(l => l.id)]);
  if (new Set(ids).size !== ids.length) fail(400);
  await tx.query(`INSERT INTO course_revisions(course_id,revision,outline,authored_by)
    VALUES ($1,$2,$3,$4)`, [id, version, outline, author]);
  return { id, revision: version };
}

export function registerCurriculum(app: FastifyInstance, db: Pool, principal: Identity, origin: string) {
  const session = sessionTransaction(db, principal, origin);
  const staff = "/api/v1/staff/courses";
  function academic<T>(req: FastifyRequest, work: (tx: PoolClient, author: string) => Promise<T>) {
    return session(req, async (tx, actor) => {
      if (!(await tx.query("SELECT FROM academic_staff WHERE user_id=$1", [actor.id])).rowCount) fail(403);
      return work(tx, actor.id);
    });
  }
  app.get(staff, req => academic(req, async tx => ({ courses: (await tx.query(`
    SELECT c.id,c.product_key AS "productKey",c.revision,c.published_revision AS "publishedRevision",r.outline->>'title' AS title
    FROM courses c JOIN course_revisions r ON (c.id,c.revision)=(r.course_id,r.revision) ORDER BY title,c.id`)).rows })));
  app.get<Course & { Querystring: { revision?: number } }>(staff + "/:id", {
    schema: { params, querystring: object({ revision }, []) }
  }, req => academic(req, async tx => (await tx.query(`
    SELECT c.id,c.product_key AS "productKey",c.published_revision AS "publishedRevision",r.revision,r.outline,
      r.authored_by AS "authoredBy",r.authored_at AS "authoredAt",r.published_by AS "publishedBy",r.published_at AS "publishedAt"
    FROM courses c JOIN course_revisions r ON r.course_id=c.id AND r.revision=coalesce($2,c.revision)
    WHERE c.id=$1`, [req.params.id, req.query.revision])).rows[0] ?? fail(404)));
  app.post<{ Body: { id: string; productKey: string; outline: Outline } }>(staff, { bodyLimit,
    schema: { body: object({ id: uuid, productKey: { ...title, maxLength: 120 }, outline: outlineSchema }) }
  }, (req, reply) => academic(req, async (tx, author) => {
    const { id, productKey, outline } = req.body;
    await tx.query("INSERT INTO courses(id,product_key) VALUES ($1,$2)", [id, productKey]);
    const result = await saveRevision(tx, id, 1, outline, author);
    reply.code(201);
    return result;
  }));
  app.put<Course & { Body: { revision: number; outline: Outline } }>(staff + "/:id", { bodyLimit,
    schema: { params, body: object({ revision, outline: outlineSchema }) }
  }, req => academic(req, async (tx, author) => {
    const next = await tx.query("UPDATE courses SET revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING revision",
      [req.params.id, req.body.revision]);
    if (!next.rowCount) fail(409);
    return saveRevision(tx, req.params.id, next.rows[0].revision, req.body.outline, author);
  }));
  app.post<Course & { Body: { revision: number } }>(staff + "/:id/publish", {
    schema: { params, body: object({ revision }) }
  }, req => academic(req, async (tx, author) => {
    const id = req.params.id;
    const version = req.body.revision;
    const row = (await tx.query(`SELECT c.revision,c.published_revision,r.outline FROM courses c
      JOIN course_revisions r ON (c.id,c.revision)=(r.course_id,r.revision) WHERE c.id=$1 FOR UPDATE OF c`, [id])).rows[0];
    if (!row) return fail(404);
    if (row.published_revision !== version) {
      if (row.revision !== version) fail(409);
      const { chapters } = row.outline as Outline;
      if (!chapters.length || chapters.some(ch => !ch.lessons.length || ch.lessons.some(l => !l.resourceId))) fail(422);
      await tx.query("UPDATE courses SET published_revision=$2 WHERE id=$1", [id, version]);
      await tx.query("UPDATE course_revisions SET published_by=$3,published_at=now() WHERE course_id=$1 AND revision=$2", [id, version, author]);
    }
    return { id, publishedRevision: version };
  }));
  const accessible = `FROM courses c JOIN course_revisions r ON (c.id,c.published_revision)=(r.course_id,r.revision)
    WHERE EXISTS (SELECT FROM enrollments e WHERE e.user_id=$1 AND e.product_key=c.product_key
      AND e.revoked_at IS NULL AND e.starts_at<=now() AND now()<e.ends_at)`;
  app.get("/api/v1/courses", req => session(req, async (tx, actor) => ({ courses: (await tx.query(
    `SELECT c.id,r.revision,r.outline->>'title' AS title ${accessible} ORDER BY title,c.id`, [actor.id])).rows })));
  app.get<Course>("/api/v1/courses/:id", { schema: { params } }, req => session(req, async (tx, actor) =>
    (await tx.query(`SELECT c.id,r.revision,r.outline ${accessible} AND c.id=$2`, [actor.id, req.params.id])).rows[0] ?? fail(404)));
}
