import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, type Academic, type sessionTransaction } from "./authorized.ts";
import { loadCourse } from "./learning.ts";

type Question = { id:string; stem:string; options:{id:string; text:string}[]; correctOptionId:string; explanation:string };
export type Quiz = { title:string; questions:Question[] };
type Source = { courseId:string; lessonId:string; quizId:string };
type AttemptPath = Source & { attemptId:string };
type Attempt = { id:string; revision:number; quiz:Quiz; submitted_at:Date|null };
type Answer = { question_id:string; option_id:string|null; correct:boolean|null };
const uuid = { type:"string", format:"uuid", pattern:"^[0-9a-f-]+$" };
const version = { type:"integer", minimum:1, maximum:2147483646 };
const textField = (maxLength:number) => ({type:"string",maxLength,pattern:"\\S"});
const object = (properties:Record<string,object>,required=Object.keys(properties)) =>
  ({type:"object",properties,required,additionalProperties:false});
const question = object({id:uuid,stem:textField(8000),options:{type:"array",minItems:2,maxItems:10,
  items:object({id:uuid,text:textField(2000)})},correctOptionId:uuid,explanation:textField(8000)});
export const quizSchema = object({title:textField(200),questions:{type:"array",maxItems:200,items:question}});
const quizParams = object({id:uuid});
const sourceParams = {courseId:uuid,lessonId:uuid,quizId:uuid};
const attemptParams = {...sourceParams,attemptId:uuid};
const published = "SELECT revision,quiz FROM quiz_revisions WHERE quiz_id=$1 AND published_at IS NOT NULL ORDER BY revision DESC LIMIT 1";

export function validateQuiz(quiz:Quiz) {
  const ids=new Set(quiz.questions.map(q=>q.id));
  if (ids.size!==quiz.questions.length) fail(400);
  for (const q of quiz.questions) {
    const options=new Set(q.options.map(o=>o.id));
    if (options.size!==q.options.length || !options.has(q.correctOptionId)) fail(400);
  }
}

async function save(tx:PoolClient, id:string, revision:number, quiz:Quiz, author:string) {
  validateQuiz(quiz);
  await tx.query("INSERT INTO quiz_revisions(quiz_id,revision,quiz,authored_by) VALUES ($1,$2,$3,$4)",[id,revision,quiz,author]);
  return {id,revision};
}

function present(q:Question, response?:Answer) {
  const visible={id:q.id,stem:q.stem,options:q.options};
  return response ? {...visible,selectedOptionId:response.option_id,correct:response.correct,
    correctOptionId:q.correctOptionId,explanation:q.explanation} : visible;
}

export function registerQuizzes(app:FastifyInstance, session:ReturnType<typeof sessionTransaction>, academic:Academic, accessible:string) {
  const staff="/api/v1/staff/quizzes";
  const source="/api/v1/courses/:courseId/lessons/:lessonId/quizzes/:quizId";
  const attemptPath=source+"/attempts/:attemptId";
  const bodyLimit=2*1024*1024;
  async function latest(tx:PoolClient,id:string) {
    // Serialize edits and publication even when the latest draft is a new row.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,8))",[id]);
    return (await tx.query("SELECT revision,quiz,published_at FROM quiz_revisions WHERE quiz_id=$1 ORDER BY revision DESC LIMIT 1",[id])).rows[0] ?? fail(404);
  }
  app.post<{Body:{id:string;quiz:Quiz}}>(staff,{bodyLimit,schema:{body:object({id:uuid,quiz:quizSchema})}},
    (req,reply)=>academic(req,async(tx,user)=>{
      const result=await save(tx,req.body.id,1,req.body.quiz,user);
      reply.code(201);
      return result;
    }));
  app.get(staff,req=>academic(req,async tx=>({quizzes:(await tx.query(`SELECT DISTINCT ON (quiz_id)
    quiz_id AS id, revision, quiz->>'title' AS title, max(revision) FILTER (WHERE published_at IS NOT NULL)
    OVER (PARTITION BY quiz_id) AS "publishedRevision" FROM quiz_revisions ORDER BY quiz_id,revision DESC`)).rows})));
  app.get<{Params:{id:string};Querystring:{revision?:number}}>(staff+"/:id",{schema:{params:quizParams,querystring:object({revision:version},[])}},
    req=>academic(req,async tx=>(await tx.query(`SELECT quiz_id AS id,revision,quiz,authored_by AS "authoredBy",
      published_by AS "publishedBy",published_at AS "publishedAt" FROM quiz_revisions WHERE quiz_id=$1
      AND ($2::integer IS NULL OR revision=$2) ORDER BY revision DESC LIMIT 1`,[req.params.id,req.query.revision])).rows[0] ?? fail(404)));
  app.put<{Params:{id:string};Body:{revision:number;quiz:Quiz}}>(staff+"/:id",{bodyLimit,schema:{params:quizParams,body:object({revision:version,quiz:quizSchema})}},
    req=>academic(req,async(tx,user)=>{
      if ((await latest(tx,req.params.id)).revision!==req.body.revision) fail(409);
      return save(tx,req.params.id,req.body.revision+1,req.body.quiz,user);
    }));
  app.post<{Params:{id:string};Body:{revision:number}}>(staff+"/:id/publish",{schema:{params:quizParams,body:object({revision:version})}},
    req=>academic(req,async(tx,user)=>{
      const row=await latest(tx,req.params.id);
      const revision=req.body.revision;
      if (row.revision!==revision) {
        if ((await tx.query(published,[req.params.id])).rows[0]?.revision!==revision) fail(409);
      } else if (!row.published_at) {
        if (!row.quiz.questions.length) fail(422);
        await tx.query("UPDATE quiz_revisions SET published_by=$3,published_at=now() WHERE quiz_id=$1 AND revision=$2",[req.params.id,revision,user]);
      }
      return {id:req.params.id,publishedRevision:revision};
    }));

  async function checkLesson(tx:PoolClient,user:string,path:Source,write:boolean) {
    const course=await loadCourse(tx,accessible,user,path.courseId,write,path.lessonId);
    const lesson=course.available(path.lessonId);
    if (!(lesson.type==="mcq_quiz" && lesson.resourceId===path.quizId) && !lesson.relatedResourceIds?.includes(path.quizId)) fail(404);
  }
  async function owned(tx:PoolClient,user:string,path:AttemptPath,write:boolean) {
    await checkLesson(tx,user,path,write);
    const result=await tx.query<Attempt>(`SELECT a.id,a.revision,a.submitted_at,r.quiz FROM quiz_attempts a
      JOIN quiz_revisions r USING(quiz_id,revision) WHERE a.id=$1 AND a.student_id=$2 AND a.quiz_id=$3 ${write?"FOR UPDATE OF a":""}`,
      [path.attemptId,user,path.quizId]);
    return result.rows[0] ?? fail(404);
  }
  app.get<{Params:Source}>(source,{schema:{params:object(sourceParams)}},req=>session(req,async(tx,actor)=>{
    await checkLesson(tx,actor.id,req.params,false);
    const row=(await tx.query(published,[req.params.quizId])).rows[0] ?? fail(404);
    const active=await tx.query("SELECT id FROM quiz_attempts WHERE student_id=$1 AND quiz_id=$2 AND submitted_at IS NULL",[actor.id,req.params.quizId]);
    return {revision:row.revision,title:row.quiz.title,questionCount:row.quiz.questions.length,mode:"tutor",activeAttemptId:active.rows[0]?.id ?? null};
  }));
  app.get<{Params:Source}>(source+"/coverage",{schema:{params:object(sourceParams)}},req=>session(req,async(tx,actor)=>{
    await checkLesson(tx,actor.id,req.params,false);
    const row=(await tx.query(published,[req.params.quizId])).rows[0] ?? fail(404);
    const questions=(row.quiz as Quiz).questions;
    const history=await tx.query(`SELECT r.question_id,
      (array_agg(r.correct ORDER BY r.recorded_at DESC,a.id DESC) FILTER (WHERE r.correct IS NOT NULL))[1] AS correct,
      (array_agg(r.option_id IS NULL ORDER BY r.recorded_at DESC,a.id DESC))[1] AS omitted
      FROM quiz_responses r JOIN quiz_attempts a ON a.id=r.attempt_id
      WHERE a.student_id=$1 AND r.question_id=ANY($2::uuid[]) GROUP BY r.question_id`,[actor.id,questions.map(q=>q.id)]);
    const byId=new Map(history.rows.map(r=>[r.question_id,r]));
    const statuses=questions.map(q=>{
      const last=byId.get(q.id);
      return {questionId:q.id,correct:last?.correct ?? null,omitted:last?.omitted ?? false};
    });
    return {revision:row.revision,total:questions.length,used:statuses.filter(s=>s.correct!==null).length,questions:statuses};
  }));
  app.post<{Params:Source;Body:{id:string;diagnosticEnrollmentId?:string}}>(source+"/attempts",{schema:{params:object(sourceParams),body:object({id:uuid,diagnosticEnrollmentId:uuid},["id"])}},
    req=>session(req,async(tx,actor)=>{
      await checkLesson(tx,actor.id,req.params,true);
      const {quizId,courseId,lessonId}=req.params;
      const id=req.body.id;
      const diagnostic=req.body.diagnosticEnrollmentId;
      if(diagnostic && !(await tx.query(`SELECT FROM welcome_resources p JOIN welcome_enrollments e ON e.id=p.enrollment_id
        JOIN courses c ON c.id=p.course_id AND c.published_revision=p.revision JOIN course_revisions r ON (r.course_id,r.revision)=(c.id,p.revision)
        CROSS JOIN LATERAL jsonb_array_elements(r.outline->'chapters') ch CROSS JOIN LATERAL jsonb_array_elements(ch->'lessons') l
        WHERE e.id=$1 AND e.user_id=$2 AND e.route='mentored' AND e.revoked_at IS NULL AND e.mentoring_end>now()
        AND p.course_id=$3 AND p.lesson_id=$4 AND p.diagnostic AND l->>'id'=$4::uuid::text AND l->>'resourceId'=$5`,
        [diagnostic,actor.id,courseId,lessonId,quizId])).rowCount) fail(404);
      await tx.query(`INSERT INTO quiz_attempts(id,student_id,quiz_id,revision,course_id,lesson_id,diagnostic_enrollment_id)
        SELECT $2,$3,$1,revision,$4,$5,$6 FROM (${published}) current_quiz ON CONFLICT DO NOTHING`,[quizId,id,actor.id,courseId,lessonId,diagnostic]);
      const result=await tx.query("SELECT id,revision FROM quiz_attempts WHERE id=$1 AND student_id=$2 AND quiz_id=$3 AND diagnostic_enrollment_id IS NOT DISTINCT FROM $4",[id,actor.id,quizId,diagnostic]);
      if (!result.rowCount && !(await tx.query(published,[quizId])).rowCount) fail(404);
      return result.rows[0] ?? fail(409);
    }));
  app.get<{Params:AttemptPath}>(attemptPath,{schema:{params:object(attemptParams)}},req=>session(req,async(tx,actor)=>{
    const attempt=await owned(tx,actor.id,req.params,false);
    const responses=await tx.query<Answer>("SELECT question_id,option_id,correct FROM quiz_responses WHERE attempt_id=$1",[attempt.id]);
    const answers=new Map(responses.rows.map(a=>[a.question_id,a]));
    return {id:attempt.id,revision:attempt.revision,title:attempt.quiz.title,submittedAt:attempt.submitted_at,
      questions:attempt.quiz.questions.map(q=>present(q,answers.get(q.id)))};
  }));
  app.put<{Params:AttemptPath & {questionId:string};Body:{optionId:string}}>(attemptPath+"/answers/:questionId",{
    schema:{params:object({...attemptParams,questionId:uuid}),body:object({optionId:uuid})}
  },req=>session(req,async(tx,actor)=>{
    const attempt=await owned(tx,actor.id,req.params,true);
    const q=attempt.quiz.questions.find(q=>q.id===req.params.questionId) ?? fail(404);
    const option=req.body.optionId;
    if (!q.options.some(o=>o.id===option)) fail(400);
    const prior=(await tx.query<Answer>("SELECT question_id,option_id,correct FROM quiz_responses WHERE attempt_id=$1 AND question_id=$2",[attempt.id,q.id])).rows[0];
    if (prior?.option_id===option) return present(q,prior);
    if (prior || attempt.submitted_at) fail(409);
    const correct=option===q.correctOptionId;
    await tx.query("INSERT INTO quiz_responses(attempt_id,question_id,option_id,correct) VALUES ($1,$2,$3,$4)",[attempt.id,q.id,option,correct]);
    return present(q,{question_id:q.id,option_id:option,correct});
  }));
  app.post<{Params:AttemptPath}>(attemptPath+"/submit",{schema:{params:object(attemptParams)}},req=>session(req,async(tx,actor)=>{
    const attempt=await owned(tx,actor.id,req.params,true);
    if (!attempt.submitted_at) {
      await tx.query(`INSERT INTO quiz_responses(attempt_id,question_id) SELECT $1,id FROM unnest($2::uuid[]) AS id
        ON CONFLICT DO NOTHING`,[attempt.id,attempt.quiz.questions.map(q=>q.id)]);
      await tx.query("UPDATE quiz_attempts SET submitted_at=clock_timestamp() WHERE id=$1",[attempt.id]);
    }
    return (await tx.query("SELECT * FROM lesson_quiz_results WHERE id=$1",[attempt.id])).rows[0];
  }));
  app.get<{Querystring:{download?:boolean}}>("/api/v1/me/quiz-results",{schema:{querystring:object({download:{type:"boolean"}},[])}},(req,reply)=>session(req,async(tx,actor)=>{
    if(req.query.download) reply.header("Content-Disposition",'attachment; filename="Project-ZY2-quiz-results.json"');
    return {results:(await tx.query(
    'SELECT id,quiz_id AS "quizId",revision,submitted_at AS "submittedAt",correct,incorrect,omitted,total FROM lesson_quiz_results WHERE student_id=$1 ORDER BY submitted_at DESC,id',
    [actor.id])).rows};
  }));
}
