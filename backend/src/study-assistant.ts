import type {FastifyInstance} from "fastify";
import type {PoolClient} from "pg";
import {createHash,randomUUID} from "node:crypto";
import {fail,type Academic,type sessionTransaction} from "./authorized.ts";
import type {registerEbooks} from "./ebooks.ts";

const uuid={type:"string",format:"uuid"},product={type:"string",minLength:1,maxLength:120};
const object=(properties:Record<string,object>,required=Object.keys(properties))=>({type:"object",properties,required,additionalProperties:false});
type Source={book:string;page:string;courseId?:string;lessonId?:string};
type Ask={id:string;product:string;source:Source;question:string};
function pageUrl(s:Source) {return `/api/v1/ebooks/${s.book}/pages/${s.page}`+(s.courseId?`?courseId=${s.courseId}&lessonId=${s.lessonId}`:"");}
export function registerStudyAssistant(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>,academic:Academic,bookFor:ReturnType<typeof registerEbooks>) {
  const base="/api/v1/me/study-assistant";
  app.put<{Params:{product:string};Body:{questions:number;days:number}}>("/api/v1/staff/ai-allowances/:product",{schema:{
    params:object({product}),body:object({questions:{type:"integer",minimum:1,maximum:100000},days:{type:"integer",minimum:1,maximum:366}})}},
    req=>academic(req,async(tx)=>{
      await tx.query(`INSERT INTO ai_allowances VALUES ($1,$2,$3) ON CONFLICT(product) DO UPDATE SET questions=excluded.questions,
        period_days=excluded.period_days`,[req.params.product,req.body.questions,req.body.days]);
      return req.body;
    }));
  async function allowance(tx:PoolClient,user:string,key:string) {
    const row=(await tx.query(`WITH policy AS (SELECT p.questions,date_bin(p.period_days*interval '1 day',
      now() AT TIME ZONE 'Asia/Karachi',timestamp '2000-01-01')::date AS start FROM ai_allowances p
      WHERE p.product=$2 AND EXISTS(SELECT FROM enrollments e WHERE e.user_id=$1 AND e.product_key=p.product
        AND e.starts_at<=now() AND now()<e.ends_at AND e.revoked_at IS NULL))
      SELECT questions,start::text,greatest(0,questions-(SELECT count(*)::int FROM ai_requests r WHERE r.student=$1 AND r.product=$2
        AND r.period_start=start AND (r.answer IS NOT NULL OR lease_until>now()))) AS remaining FROM policy`,[user,key])).rows[0];
    return row??fail(403);
  }
  async function sourcePage(tx:PoolClient,user:string,s:Source) {
    const book=await bookFor(tx,user,s.book,s);
    return book.manuscript.pages.find(p=>p.id===s.page)??fail(404);
  }
  app.get<{Params:{product:string}}>(base+"/allowance/:product",{schema:{params:object({product})}},req=>session(req,(tx,a)=>allowance(tx,a.id,req.params.product)));
  app.post<{Body:Ask}>(base,{schema:{body:object({id:uuid,product,source:{...object({book:uuid,page:uuid,courseId:uuid,lessonId:uuid},["book","page"]),
    dependencies:{courseId:["lessonId"],lessonId:["courseId"]}},question:{type:"string",maxLength:2000,pattern:"\\S"}})}},async req=>{
    const b=req.body,lease=randomUUID(),href=pageUrl(b.source);
    const reservation=await session(req,async(tx,a)=>{
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,27))",[a.id]);
      const page=await sourcePage(tx,a.id,b.source),budget=await allowance(tx,a.id,b.product);
      const digest=createHash("sha256").update(JSON.stringify(page)).digest("hex");
      const prior=(await tx.query(`SELECT answer,lease_until>now() AS busy,(source=$3 AND product=$4 AND question=$5 AND source_hash=$6) AS same
        FROM ai_requests WHERE student=$1 AND id=$2`,[a.id,b.id,b.source,b.product,b.question,digest])).rows[0];
      if(prior && !prior.same) fail(409);
      if(prior?.answer) return {answer:prior.answer as string,user:a.id,page};
      if(prior?.busy) fail(409);
      if(!budget.remaining) fail(429);
      if(!process.env.STUDY_ASSISTANT_URL) fail(503);
      await tx.query(`INSERT INTO ai_requests(student,id,product,period_start,source,question,lease,source_hash,lease_until)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '1 minute') ON CONFLICT(student,id) DO UPDATE SET
        lease=excluded.lease,lease_until=excluded.lease_until,period_start=excluded.period_start`,
        [a.id,b.id,b.product,budget.start,b.source,b.question,lease,digest]);
      return {user:a.id,page,answer:null};
    });
    if(reservation.answer) return {answer:reservation.answer,href};
    let answer:string;
    try {
      const response=await fetch(process.env.STUDY_ASSISTANT_URL!,{method:"POST",redirect:"error",signal:AbortSignal.timeout(30000),
        headers:{"Content-Type":"application/json",...(process.env.STUDY_ASSISTANT_TOKEN?{Authorization:"Bearer "+process.env.STUDY_ASSISTANT_TOKEN}:{})},
        body:JSON.stringify({question:b.question,source:reservation.page})});
      if(!response.ok) throw Error();
      const data=await response.json() as {answer?:unknown};
      if(typeof data.answer!=="string" || !data.answer.trim() || data.answer.length>20000) throw Error();
      answer=data.answer;
    } catch {
      await session(req,(tx,a)=>tx.query("UPDATE ai_requests SET lease_until=now() WHERE student=$1 AND id=$2 AND lease=$3",[a.id,b.id,lease]));
      return fail(503);
    }
    return session(req,async(tx,a)=>{
      const page=await sourcePage(tx,a.id,b.source);
      await allowance(tx,a.id,b.product);
      if(JSON.stringify(page)!==JSON.stringify(reservation.page)) fail(409);
      if(!(await tx.query("UPDATE ai_requests SET answer=$4 WHERE student=$1 AND id=$2 AND lease=$3 AND lease_until>now()",
        [a.id,b.id,lease,answer])).rowCount) fail(409);
      return {answer,href};
    });
  });
}
