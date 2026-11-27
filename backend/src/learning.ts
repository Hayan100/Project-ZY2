import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, type sessionTransaction } from "./authorized.ts";
import type { Lesson, Outline } from "./curriculum.ts";

export function validatePrerequisites(lessons: Lesson[]) {
  const waiting = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const ready: string[] = [];
  for (const lesson of lessons) {
    const prerequisites = lesson.prerequisiteIds ?? [];
    if (!prerequisites.length) ready.push(lesson.id);
    waiting.set(lesson.id, prerequisites.length);
    for (const id of prerequisites) {
      if (!dependents.has(id)) dependents.set(id, []);
      dependents.get(id)!.push(lesson.id);
    }
  }
  for (const id of ready) {
    for (const child of dependents.get(id) ?? []) {
      const count = waiting.get(child)! - 1;
      waiting.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (ready.length !== lessons.length) fail(422);
}

type Position = { videoSeconds?: number; pageId?: string };
type Saved = { lesson_id: string; resource_id: string; lesson_type: string; version: number; completed: boolean; position: Position; updated_at: Date };
type Path = { Params: { id: string; lessonId: string } };
const uuid = { type: "string", format: "uuid" };
const params = { type: "object", properties: { id: uuid, lessonId: uuid }, required: ["id","lessonId"] };
const counter = { type: "integer", minimum: 0, maximum: 2147483646 };
const progressBody = { type: "object", required: ["revision","version","position","completed"], additionalProperties: false,
  properties: { revision: { ...counter, minimum: 1 }, version: counter, completed: { type: "boolean" },
    position: { type: "object", additionalProperties: false, properties: { videoSeconds: counter, pageId: uuid } } } };

export async function loadCourse(tx: PoolClient, accessible: string, user: string, course: string, write = false) {
  const row = (await tx.query<{ revision: number; outline: Outline; now: Date }>(
    `SELECT r.revision,r.outline,now() AS now ${accessible} AND c.id=$2 ${write ? "FOR SHARE OF c" : ""}`, [user,course])).rows[0];
  if (!row) return fail(404);
  const saved = await tx.query<Saved>("SELECT * FROM lesson_progress WHERE user_id=$1 AND course_id=$2", [user,course]);
  const lessons = row.outline.chapters.flatMap(ch => ch.lessons);
  const current = new Map(lessons.map(l => [l.id,l]));
  const progress = new Map(saved.rows.filter(p => {
    const l = current.get(p.lesson_id);
    return l?.resourceId === p.resource_id && l.type === p.lesson_type;
  }).map(p => [p.lesson_id,p]));
  function lockReason(l: Lesson) {
    if (l.releaseAt && Date.parse(l.releaseAt) > row.now.getTime()) return "scheduled";
    if (l.prerequisiteIds?.some(id => !progress.get(id)?.completed)) return "prerequisite";
    return null;
  }
  function available(id: string) {
    const lesson = current.get(id);
    if (!lesson) return fail(404);
    if (lockReason(lesson)) return fail(403);
    return lesson;
  }
  return { ...row, lessons, progress, lockReason, available };
}

export function registerLearning(app: FastifyInstance, session: ReturnType<typeof sessionTransaction>, accessible: string) {
  const coursePath = "/api/v1/courses/:id";
  const lessonPath = coursePath + "/lessons/:lessonId";
  app.get<{ Params: { id: string } }>(coursePath, { schema: { params: { ...params, required: ["id"] } } }, req =>
    session(req, async (tx, actor) => {
      const { revision, outline, lessons, progress, lockReason } = await loadCourse(tx,accessible,actor.id,req.params.id);
      let next: Lesson | undefined;
      for (const l of lessons) {
        if (lockReason(l) || progress.get(l.id)?.completed) continue;
        if (!next || (progress.get(l.id)?.updated_at.getTime() ?? 0) > (progress.get(next.id)?.updated_at.getTime() ?? 0)) next = l;
      }
      return { id: req.params.id, revision, continueLessonId: next?.id ?? null,
        completedLessons: lessons.filter(l => progress.get(l.id)?.completed).length, totalLessons: lessons.length,
        outline: { ...outline, chapters: outline.chapters.map(ch => ({ ...ch, lessons: ch.lessons.map(l => {
          const locked = lockReason(l);
          return locked ? { id:l.id, title:l.title, type:l.type, locked, releaseAt:l.releaseAt } :
            { ...l, completed:progress.get(l.id)?.completed ?? false };
        }) })) } };
    }));
  app.get<Path>(lessonPath, { schema: { params } }, req => session(req, async (tx, actor) => {
    const course = await loadCourse(tx,accessible,actor.id,req.params.id);
    const lesson = course.available(req.params.lessonId);
    const saved = course.progress.get(lesson.id);
    return { revision:course.revision, lesson, version:saved?.version ?? 0, position:saved?.position ?? {}, completed:saved?.completed ?? false };
  }));
  app.put<Path & { Body: { revision:number; version:number; position:Position; completed:boolean } }>(
    lessonPath + "/progress", { schema: { params, body:progressBody } }, req => session(req, async (tx,actor) => {
      const { revision, version, position, completed } = req.body;
      const course = await loadCourse(tx,accessible,actor.id,req.params.id,true);
      if (course.revision !== revision) fail(409);
      const l = course.available(req.params.lessonId);
      if ((position.videoSeconds !== undefined && l.type !== "video") ||
          (position.pageId !== undefined && l.type !== "html_article")) fail(400);
      const key = [actor.id,req.params.id,l.id,l.resourceId,l.type];
      const result = version === 0 ? await tx.query(`INSERT INTO lesson_progress
        (user_id,course_id,lesson_id,resource_id,lesson_type,position,completed) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT DO NOTHING RETURNING version,position,completed`, [...key,position,completed]) :
        await tx.query(`UPDATE lesson_progress SET version=version+1, position=$6, completed=completed OR $7, updated_at=clock_timestamp()
          WHERE user_id=$1 AND course_id=$2 AND lesson_id=$3 AND resource_id=$4 AND lesson_type=$5 AND version=$8
          RETURNING version,position,completed`, [...key,position,completed,version]);
      return result.rows[0] ?? fail(409);
    }));
}
