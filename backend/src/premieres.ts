import type {FastifyInstance} from "fastify";
import type {PoolClient} from "pg";
import {fail,type Academic,type sessionTransaction} from "./authorized.ts";
import {loadCourse} from "./learning.ts";
import {recordedPage,videoPolicy,mediaViewer} from "./media-watermark.ts";

const uuid={type:"string",format:"uuid"};
const dateTime={type:"string",format:"date-time"};
const object=(properties:Record<string,object>,required=Object.keys(properties))=>({type:"object",properties,required,additionalProperties:false});
type Path={course:string;lesson:string};
const params=object({course:uuid,lesson:uuid});
export function registerPremieres(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>,academic:Academic,accessible:string) {
  const base="/api/v1/courses/:course/lessons/:lesson/premiere";
  async function context(tx:PoolClient,student:string,p:Path) {
    const course=await loadCourse(tx,accessible,student,p.course,true);
    const lesson=course.available(p.lesson);
    if(!lesson.premiere || !lesson.resourceId) return fail(404);
    const policy=lesson.premiere;
    const key=[student,p.course,p.lesson,lesson.resourceId];
    const now=course.now.getTime();
    const slot=policy.slots.find(s=>Date.parse(s.opens)<=now && now<Date.parse(s.closes));
    return {policy,key,now,slot};
  }
  async function status(tx:PoolClient,student:string,p:Path,start=false) {
    const {policy,key,now,slot}=await context(tx,student,p);
    if(start && slot) await tx.query(`INSERT INTO premiere_visits(student,course,lesson,resource,opened_at,deadline)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[...key,slot.opens,slot.continueUntil]);
    const visits=(await tx.query(`SELECT opened_at,deadline FROM premiere_visits
      WHERE (student,course,lesson,resource)=($1,$2,$3,$4) AND deadline>now() ORDER BY deadline DESC`,key)).rows;
    const continuation=visits.map(v=>{
      const current=policy.slots.find(s=>Date.parse(s.opens)===v.opened_at.getTime());
      return current?Math.min(v.deadline.getTime(),Date.parse(current.continueUntil)):0;
    }).reduce((a,b)=>Math.max(a,b),0);
    const played=(await tx.query(`SELECT coalesce(sum(upper(segment)-lower(segment)),0)::int AS seconds
      FROM unnest((SELECT range_agg(played) FROM premiere_visits WHERE (student,course,lesson,resource)=($1,$2,$3,$4))
        * int4multirange(int4range(0,$5))) segment`,[...key,policy.durationSeconds])).rows[0].seconds;
    const requests=(await tx.query(`SELECT id,reason,requested_at,decision,decided_at,expires_at FROM replay_requests
      WHERE (student,course,lesson,resource)=($1,$2,$3,$4) ORDER BY requested_at DESC,id`,key)).rows;
    const qualified=played*100>=policy.durationSeconds*policy.thresholdPercent;
    const replay=qualified || requests.some(r=>r.decision==="approved" && r.expires_at.getTime()>now);
    const canPlay=!!slot || continuation>now || replay;
    if(start && !canPlay) fail(403);
    return {slots:policy.slots,slot:slot??null,continueUntil:continuation>now?new Date(continuation):null,
      durationSeconds:policy.durationSeconds,thresholdPercent:policy.thresholdPercent,playedSeconds:played,
      qualified,replay,canPlay,canDownload:policy.downloads && replay,requests};
  }
  app.get<{Params:Path}>(base,{schema:{params}},req=>session(req,(tx,a)=>status(tx,a.id,req.params)));
  app.get<{Params:Path}>("/api/v1/courses/:course/lessons/:lesson/watch",{schema:{params}},async(req,reply)=>{
    const page=await recordedPage(req,session,async(tx,student)=>{
      const course=await loadCourse(tx,accessible,student,req.params.course,false,req.params.lesson);
      const lesson=course.available(req.params.lesson);
      if(lesson.type!=="video" || !lesson.resourceId) return fail(404);
      if(lesson.premiere)await status(tx,student,req.params,true);
      return lesson.resourceId;
    });
    return reply.header("Content-Security-Policy",page.policy).type("text/html; charset=utf-8").send(page.html);
  });
  app.post<{Params:Path}>(base+"/start",{schema:{params}},req=>session(req,(tx,a)=>status(tx,a.id,req.params,true)));
  app.post<{Params:Path}>(base+"/download-authorization",{schema:{params}},req=>session(req,async(tx,a)=>{
    const state=await status(tx,a.id,req.params);
    if(!state.canDownload) fail(403);
    const {rows}=await tx.query(`SELECT least(now()+interval '168 hours',max(e.ends_at),
      coalesce($3::timestamptz,'infinity'::timestamptz)) AS expires
      FROM enrollments e JOIN courses c ON c.product_key=e.product_key WHERE c.id=$1 AND e.user_id=$2
      AND e.starts_at<=now() AND e.ends_at>now() AND e.revoked_at IS NULL HAVING count(*)>0`,
      [req.params.course,a.id,state.qualified?null:new Date(Math.max(...state.requests.filter(r=>r.decision==="approved").map(r=>+r.expires_at)))]);
    if(!rows.length || +rows[0].expires<=Date.now()) fail(403);
    const identity=await mediaViewer(tx,a.id);
    if(!identity.phone)fail(422);
    return {course:req.params.course,lesson:req.params.lesson,expiresAt:rows[0].expires,watermark:{identity,...videoPolicy}};
  }));
  app.put<{Params:Path;Body:{id:string;reason:string}}>(base+"/requests",{schema:{params,body:object({id:uuid,reason:{type:"string",pattern:"\\S",maxLength:2000}})}},
    req=>session(req,async(tx,a)=>{
      const {key,policy,now}=await context(tx,a.id,req.params);
      if(!policy.slots.some(s=>Date.parse(s.closes)<=now)) fail(409);
      await tx.query(`INSERT INTO replay_requests(student,course,lesson,resource,id,reason) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT DO NOTHING`,[...key,req.body.id,req.body.reason]);
      return (await tx.query(`SELECT id,decision FROM replay_requests WHERE (student,course,lesson,resource)=($1,$2,$3,$4)
        AND id=$5 AND reason=$6`,[...key,req.body.id,req.body.reason])).rows[0]??fail(409);
    }));
  const staff="/api/v1/staff/replay-requests";
  app.get(staff,req=>academic(req,async tx=>({requests:(await tx.query(`SELECT id,student,course,lesson,resource,reason,requested_at
    FROM replay_requests WHERE decision IS NULL ORDER BY requested_at,id`)).rows})));
  app.put<{Params:{id:string};Body:{decision:"approved"|"declined";expiresAt?:string}}>(staff+"/:id",{schema:{params:object({id:uuid}),
    body:object({decision:{enum:["approved","declined"]},expiresAt:dateTime},["decision"])}},req=>academic(req,async(tx,reviewer)=>{
      const {decision,expiresAt}=req.body;
      if((decision==="approved")!==!!expiresAt) fail(400);
      if(expiresAt && Date.parse(expiresAt)<=Date.now()) fail(422);
      const row=(await tx.query(`UPDATE replay_requests SET decision=$2,expires_at=$3,reviewer=$4,decided_at=now()
        WHERE id=$1 AND decision IS NULL RETURNING id,decision,expires_at`,[req.params.id,decision,expiresAt,reviewer])).rows[0];
      if(row) return row;
      return (await tx.query(`SELECT id,decision,expires_at FROM replay_requests WHERE id=$1 AND decision=$2
        AND expires_at IS NOT DISTINCT FROM $3::timestamptz AND reviewer=$4`,[req.params.id,decision,expiresAt,reviewer])).rows[0]??fail(409);
    }));
  // Import confirmed played intervals from the academy's playback records.
  type Observation={student:string;resource:string;slotOpens:string;observedAt:string;from:number;to:number};
  const second={type:"integer",minimum:0,maximum:86400};
  app.put<{Params:Path;Body:Observation}>("/api/v1/staff/courses/:course/lessons/:lesson/played",{schema:{params,body:object({
    student:{type:"string",minLength:1,maxLength:200},resource:uuid,slotOpens:dateTime,observedAt:dateTime,from:second,to:second})}},
    req=>academic(req,async tx=>{
      const b=req.body;
      const {key,policy}=await context(tx,b.student,req.params);
      const slot=policy.slots.find(s=>Date.parse(s.opens)===Date.parse(b.slotOpens));
      if(!slot || key[3]!==b.resource || b.from>=b.to || b.to>policy.durationSeconds || Date.parse(b.observedAt)>Date.parse(slot.continueUntil)) fail(422);
      const changed=await tx.query(`UPDATE premiere_visits SET played=played+int4multirange(int4range($6,$7))
        WHERE (student,course,lesson,resource)=($1,$2,$3,$4) AND opened_at=$5 AND $8::timestamptz BETWEEN started_at AND least(deadline,now())`,
        [...key,b.slotOpens,b.from,b.to,b.observedAt]);
      if(!changed.rowCount) fail(409);
      return {accepted:true};
    }));
}
