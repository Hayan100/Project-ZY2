import type { FastifyInstance } from "fastify";
import { fail, type sessionTransaction } from "./authorized.ts";

export function registerExports(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>) {
  const base="/api/v1/me/exports";
  app.get(base,req=>session(req,async()=>({
    notes:base+"/notes",planner:base+"/planner",performance:"/api/v1/me/progress?download=true",
    results:"/api/v1/me/quiz-results?download=true"
  })));
  type Note={title:string;body:string;version:number};
  app.put<{Params:{id:string};Body:Note}>("/api/v1/me/notes/:id",{schema:{
    params:{type:"object",required:["id"],properties:{id:{type:"string",format:"uuid"}}},
    body:{type:"object",additionalProperties:false,required:["title","body","version"],properties:{
      title:{type:"string",pattern:"\\S",maxLength:200},body:{type:"string",maxLength:20000},
      version:{type:"integer",minimum:0,maximum:2147483646}
    }}
  }},req=>session(req,async(tx,actor)=>{
    const {title,body,version}=req.body;
    const args=[actor.id,req.params.id,title,body];
    const result=version===0
      ? await tx.query("INSERT INTO personal_notes(student_id,id,title,body) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING version",args)
      : await tx.query(`UPDATE personal_notes SET title=$3,body=$4,version=version+1
          WHERE student_id=$1 AND id=$2 AND version=$5 RETURNING version`,[...args,version]);
    if(result.rowCount) return result.rows[0];
    // A retry after a lost response can acknowledge the identical committed write.
    return (await tx.query(`SELECT version FROM personal_notes WHERE student_id=$1 AND id=$2
      AND title=$3 AND body=$4 AND version=$5`,[...args,version+1])).rows[0] ?? fail(409);
  }));
  app.get(base+"/notes",(req,reply)=>session(req,async(tx,actor)=>{
    const {rows}=await tx.query("SELECT id,title,body,version FROM personal_notes WHERE student_id=$1 ORDER BY id",[actor.id]);
    reply.header("Content-Disposition",'attachment; filename="Project-ZY2-notes.json"');
    return {notes:rows};
  }));
}
