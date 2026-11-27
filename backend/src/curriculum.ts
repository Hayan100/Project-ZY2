import { validatePrerequisites } from "./learning.ts";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail,type Academic,type sessionTransaction } from "./authorized.ts";

export type Premiere = {durationSeconds:number; thresholdPercent:number; downloads:boolean;
  slots:{opens:string;closes:string;continueUntil:string}[]};
export type Lesson = { premiere?:Premiere; estimatedMinutes?:number; id: string; title: string; type: string; resourceId?: string; relatedResourceIds?: string[]; releaseAt?: string; prerequisiteIds?: string[] };
export type Outline = {
  title: string; exam?:string; examYear?: number; provinces?: string[];
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
const instant={type:"string",format:"date-time",pattern:"(Z|[+-][0-9]{2}:[0-9]{2})$"};
const premiere=object({durationSeconds:{type:"integer",minimum:1,maximum:86400},
  thresholdPercent:{type:"integer",minimum:1,maximum:100},downloads:{type:"boolean"},
  slots:{...array(object({opens:instant,closes:instant,continueUntil:instant}),128),minItems:1}});
const lesson = object({ estimatedMinutes:{type:"integer",minimum:1,maximum:1440}, id: uuid, title, type: { enum: ["video","html_article","mcq_quiz","flashcard_review"] },
  releaseAt: { type: "string", format: "date-time", pattern: "(Z|[+-][0-9]{2}:[0-9]{2})$" }, prerequisiteIds: { ...array(uuid, 64), uniqueItems: true },
  premiere,resourceId: uuid, relatedResourceIds: { ...array(uuid, 64), uniqueItems: true } }, ["id","title","type"]);
const chapter = object({ id: uuid, title, lessons: array(lesson, 500) });
const outlineSchema = object({ title, exam:title, chapters: array(chapter, 200), examYear: { type: "integer", minimum: 2000, maximum: 9999 },
  provinces: { ...array(title, 32), uniqueItems: true } }, ["title","chapters"]);
const bodyLimit = 1024 * 1024;

async function saveRevision(tx: PoolClient, id: string, version: number, outline: Outline, author: string) {
  const ids = outline.chapters.flatMap(ch => [ch.id, ...ch.lessons.map(l => l.id)]);
  if (new Set(ids).size !== ids.length) fail(400);
  for(const {lessons} of outline.chapters) for(const l of lessons) if(l.premiere) {
    if(l.type!=="video") fail(422);
    let previousClose=-Infinity;
    for(const slot of l.premiere.slots) {
      const open=Date.parse(slot.opens),close=Date.parse(slot.closes);
      if(open<previousClose || open>=close || close>Date.parse(slot.continueUntil)) fail(422);
      previousClose=close;
    }
  }
  await tx.query(`INSERT INTO course_revisions(course_id,revision,outline,authored_by)
    VALUES ($1,$2,$3,$4)`, [id, version, outline, author]);
  return { id, revision: version };
}

export function registerCourses(app: FastifyInstance, session: ReturnType<typeof sessionTransaction>, academic: Academic, accessible: string) {
  const staff = "/api/v1/staff/courses";
  app.get<{ Querystring: { kind?:string; q?:string; offset?:number } }>(staff+"/resources", {
    schema:{querystring:object({kind:{enum:["ebook","quiz","deck","sheet","replay"]},q:{type:"string",maxLength:200},
      offset:{type:"integer",minimum:0,maximum:2147483647}},[])}
  }, req => academic(req, async tx => {
    const {kind,q="",offset=0} = req.query;
    const {rows} = await tx.query(`WITH resources(kind,id,title) AS (
      SELECT 'ebook',b.id,r.manuscript->>'title' FROM ebooks b
        JOIN ebook_revisions r ON (b.id,b.published_revision)=(r.book_id,r.revision)
      UNION ALL SELECT 'quiz',quiz_id,quiz->>'title' FROM
        (SELECT DISTINCT ON (quiz_id) quiz_id,quiz FROM quiz_revisions
         WHERE published_at IS NOT NULL ORDER BY quiz_id,revision DESC) published_quizzes
      UNION ALL SELECT 'deck',deck_id,deck->>'title' FROM published_decks
      UNION ALL SELECT 'sheet',id,title FROM academy_sheets
      UNION ALL SELECT 'replay',replay::uuid,title FROM
        (SELECT DISTINCT ON (replay) replay,title FROM classes WHERE replay IS NOT NULL AND pg_input_is_valid(replay,'uuid') AND closes<=now()
         ORDER BY replay,closes DESC,id) finished_classes
    ) SELECT kind,id,title FROM resources WHERE ($1::text IS NULL OR kind=$1)
        AND strpos(lower(title),lower($2))>0 ORDER BY lower(title),kind,id LIMIT 51 OFFSET $3`,[kind,q.trim(),offset]);
    return {resources:rows.slice(0,50),nextOffset:rows.length>50 ? offset+50 : null};
  }));
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
      validatePrerequisites(chapters.flatMap(ch => ch.lessons));
      await tx.query("UPDATE courses SET published_revision=$2 WHERE id=$1", [id, version]);
      await tx.query("UPDATE course_revisions SET published_by=$3,published_at=now() WHERE course_id=$1 AND revision=$2", [id, version, author]);
    }
    return { id, publishedRevision: version };
  }));
  app.get("/api/v1/courses", req => session(req, async (tx, actor) => ({ courses: (await tx.query(
    `SELECT c.id,r.revision,r.outline->>'title' AS title ${accessible} ORDER BY title,c.id`, [actor.id])).rows })));
}
