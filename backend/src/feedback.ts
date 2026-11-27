import type {FastifyInstance} from "fastify";
import type {PoolClient} from "pg";
import {fail,type sessionTransaction} from "./authorized.ts";
import {obj,params,uuid,label,type Path} from "./community.ts";
async function leadership(tx:PoolClient,user:string) {
  if(!(await tx.query("SELECT FROM feedback_leads WHERE staff=$1",[user])).rowCount) fail(403);
}
export function registerFeedback(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>) {
  const staff="/api/v1/staff/feedback",mine="/api/v1/me/feedback";
  type Survey={id:string;batch:string;title:string;questions:string[];opens:string;periodDays:number;minGroup:number;subjectStaff?:string;reviewer:string};
  app.post<{Body:Survey}>(staff,{schema:{body:obj({id:uuid,batch:uuid,title:label(200),questions:{type:"array",items:label(200),minItems:1,maxItems:12,uniqueItems:true},
    opens:{type:"string",format:"date-time"},periodDays:{type:"integer",minimum:1,maximum:366},minGroup:{type:"integer",minimum:2,maximum:10000},
    subjectStaff:label(200),reviewer:label(200)},["id","batch","title","questions","opens","periodDays","minGroup","reviewer"])}},req=>session(req,async(tx,a)=>{
    await leadership(tx,a.id);
    const b=req.body;
    if(b.reviewer===b.subjectStaff) fail(422);
    await tx.query("INSERT INTO feedback_surveys VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [b.id,b.batch,b.title,JSON.stringify(b.questions),b.opens,b.periodDays,b.minGroup,b.subjectStaff,b.reviewer,a.id]);
    return {id:b.id};
  }));
  const available=`FROM feedback_surveys s WHERE s.opens<=now() AND EXISTS(SELECT FROM active_planner_batches b WHERE
    b.batch_id=s.batch AND b.user_id=$1 AND b.starts_at<=now() AND now()<b.ends_at)`;
  const period="floor(extract(epoch FROM now()-s.opens)/(86400*s.period_days))::int";
  app.get(mine,req=>session(req,async(tx,a)=>({surveys:(await tx.query(`SELECT s.id,s.title,s.questions,${period} AS period,s.reviewer,
    EXISTS(SELECT FROM feedback_responses f WHERE f.survey=s.id AND f.student=$1 AND f.period=${period}) AS submitted ${available}`,[a.id])).rows})));
  app.put<Path & {Body:{period:number;ratings:number[];comment:string}}>(mine+"/:id",{schema:{params,body:obj({
    period:{type:"integer",minimum:0},ratings:{type:"array",items:{type:"integer",minimum:1,maximum:5},minItems:1,maxItems:12},
    comment:{type:"string",maxLength:2000}})}},req=>session(req,async(tx,a)=>{
    const s=(await tx.query(`SELECT s.questions,${period} AS period ${available} AND s.id=$2`,[a.id,req.params.id])).rows[0]??fail(404);
    const b=req.body;
    if(s.period!==b.period || b.ratings.length!==s.questions.length) fail(409);
    const args=[req.params.id,b.period,a.id,JSON.stringify(b.ratings),b.comment];
    await tx.query("INSERT INTO feedback_responses(survey,period,student,ratings,comment) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",args);
    return (await tx.query("SELECT period,at FROM feedback_responses WHERE (survey,period,student,ratings,comment)=($1,$2,$3,$4,$5)",args)).rows[0]??fail(409);
  }));
  app.get<Path>(staff+"/:id/responses",{schema:{params}},req=>session(req,async(tx,a)=>{
    if(!(await tx.query("SELECT FROM feedback_surveys WHERE id=$1 AND reviewer=$2",[req.params.id,a.id])).rowCount) fail(403);
    return {responses:(await tx.query("SELECT period,student,ratings,comment,at FROM feedback_responses WHERE survey=$1 ORDER BY at",[req.params.id])).rows};
  }));
  app.get<Path>(staff+"/:id/trends",{schema:{params}},req=>session(req,async(tx,a)=>{
    await leadership(tx,a.id);
    const s=(await tx.query("SELECT min_group FROM feedback_surveys WHERE id=$1 AND subject_staff IS DISTINCT FROM $2",[req.params.id,a.id])).rows[0]??fail(404);
    return {trends:(await tx.query(`SELECT period,n AS question,count(*)::int AS respondents,round(avg(v::int),2)::float AS mean
      FROM feedback_responses r CROSS JOIN LATERAL jsonb_array_elements_text(r.ratings) WITH ORDINALITY scores(v,n)
      WHERE survey=$1 GROUP BY period,n HAVING count(*)>=$2 ORDER BY period,n`,[req.params.id,s.min_group])).rows,
      actions:(await tx.query("SELECT id,body,at FROM feedback_actions WHERE survey=$1 ORDER BY at,id",[req.params.id])).rows};
  }));
  app.post<Path & {Body:{id:string;body:string}}>(staff+"/:id/actions",{schema:{params,body:obj({id:uuid,body:label(2000)})}},req=>session(req,async(tx,a)=>{
    await leadership(tx,a.id);
    return (await tx.query(`INSERT INTO feedback_actions(id,survey,actor,body) SELECT $1,id,$2,$3 FROM feedback_surveys
      WHERE id=$4 AND subject_staff IS DISTINCT FROM $2 RETURNING id`,[req.body.id,a.id,req.body.body,req.params.id])).rows[0]??fail(404);
  }));
}
