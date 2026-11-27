import type { FastifyInstance } from "fastify";
import { fail, type sessionTransaction } from "./authorized.ts";

export function registerExports(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>) {
  const base="/api/v1/me/exports";
  app.get(base,req=>session(req,async()=>({
    notes:base+"/notes",planner:base+"/planner",performance:"/api/v1/me/progress?download=true",
    results:base+"/results"
  })));
  app.get(base+"/results",(req,reply)=>session(req,async(tx,a)=>{
    const quizzes=(await tx.query(`SELECT id,quiz_id AS "quizId",revision,submitted_at AS "submittedAt",correct,incorrect,omitted,total
      FROM lesson_quiz_results WHERE student_id=$1 ORDER BY submitted_at,id`,[a.id])).rows;
    const formal=(await tx.query(`SELECT s.id,s.event,s.score,s.correct,s.incorrect,s.omitted,s.finished_at
      FROM formal_scores s JOIN formal_tests t ON t.id=s.event WHERE s.student=$1 AND now()>=(t.rules->>'scoreRelease')::timestamptz
      ORDER BY s.finished_at,s.id`,[a.id])).rows;
    reply.header("Content-Disposition",'attachment; filename="Project-ZY2-results.json"');
    return {quizzes,formal};
  }));
  const label={type:"string",maxLength:200};
  type Note={title:string;body:string;version:number;subject?:string;topic?:string};
  app.get<{Querystring:{subject?:string;topic?:string}}>("/api/v1/me/notes",{schema:{querystring:{
    type:"object",additionalProperties:false,properties:{subject:label,topic:label}
  }}},req=>session(req,async(tx,a)=>({notes:(await tx.query(`SELECT id,title,body,subject,topic,version FROM personal_notes
    WHERE student_id=$1 AND ($2::text IS NULL OR subject=$2) AND ($3::text IS NULL OR topic=$3)
    ORDER BY subject,topic,title,id`,[a.id,req.query.subject,req.query.topic])).rows})));
  app.get<{Params:{id:string}}>("/api/v1/me/notes/:id/history",{schema:{params:{
    type:"object",properties:{id:{type:"string",format:"uuid"}},required:["id"]
  }}},req=>session(req,async(tx,a)=>({versions:(await tx.query(`SELECT version,title,body,subject,topic FROM personal_note_versions
    WHERE student_id=$1 AND id=$2 ORDER BY version DESC`,[a.id,req.params.id])).rows})));
  app.put<{Params:{id:string};Body:Note}>("/api/v1/me/notes/:id",{schema:{
    params:{type:"object",required:["id"],properties:{id:{type:"string",format:"uuid"}}},
    body:{type:"object",additionalProperties:false,required:["title","body","version"],properties:{
      title:{type:"string",pattern:"\\S",maxLength:200},body:{type:"string",maxLength:20000},
      subject:label,topic:label,version:{type:"integer",minimum:0,maximum:2147483646}
    }}
  }},req=>session(req,async(tx,actor)=>{
    const {title,body,version}=req.body;
    const args=[actor.id,req.params.id,title,body,req.body.subject,req.body.topic];
    const result=version===0
      ? await tx.query(`INSERT INTO personal_notes(student_id,id,title,body,subject,topic) VALUES ($1,$2,$3,$4,coalesce($5,''),coalesce($6,''))
          ON CONFLICT DO NOTHING RETURNING version`,args)
      : await tx.query(`UPDATE personal_notes SET title=$3,body=$4,subject=coalesce($5,subject),topic=coalesce($6,topic),version=version+1
          WHERE student_id=$1 AND id=$2 AND version=$7 RETURNING version`,[...args,version]);
    if(result.rowCount) return result.rows[0];
    // A retry after a lost response can acknowledge the identical committed write.
    return (await tx.query(`SELECT version FROM personal_notes WHERE student_id=$1 AND id=$2
      AND title=$3 AND body=$4 AND subject=coalesce($5,subject) AND topic=coalesce($6,topic) AND version=$7`,[...args,version+1])).rows[0] ?? fail(409);
  }));
  app.get(base+"/notes",(req,reply)=>session(req,async(tx,actor)=>{
    const {rows}=await tx.query("SELECT id,title,body,version FROM personal_notes WHERE student_id=$1 ORDER BY id",[actor.id]);
    reply.header("Content-Disposition",'attachment; filename="Project-ZY2-notes.json"');
    const annotations=(await tx.query(`SELECT DISTINCT ON(id) id,book,page,revision,body,version FROM ebook_annotations
      WHERE student=$1 ORDER BY id,version DESC`,[actor.id])).rows;
    const ink=(await tx.query(`SELECT id,book,page,revision,points,version FROM
      (SELECT DISTINCT ON(id) id,book,page,revision,points,version FROM page_ink WHERE student=$1 ORDER BY id,version DESC) strokes
      WHERE jsonb_array_length(points)>0 ORDER BY id`,[actor.id])).rows;
    return {notes:rows,annotations,ink};
  }));
}
