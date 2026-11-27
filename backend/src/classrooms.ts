import type {FastifyInstance} from "fastify";
import type {PoolClient} from "pg";
import { youtubeClassPage } from "./youtube-class.ts";
import {recordedPage,mediaViewer} from "./media-watermark.ts";
import {createHmac} from "node:crypto";
import {fail,type Academic,type sessionTransaction} from "./authorized.ts";
const uuid={type:"string",format:"uuid"},instant={type:"string",format:"date-time"};
const text=(maxLength:number)=>({type:"string",pattern:"\\S",maxLength});
const object=(properties:Record<string,object>,required=Object.keys(properties))=>({type:"object",properties,required,additionalProperties:false});
const params=object({id:uuid});
const viewingSession=(sessionId:string,classId:string)=>createHmac("sha256",sessionId).update(classId).digest("hex");
type Path={Params:{id:string}};
const eligible=`EXISTS(SELECT FROM enrollments e WHERE e.user_id=$1 AND e.product_key=c.product AND e.revoked_at IS NULL
  AND e.starts_at<=now() AND now()<e.ends_at) AND (c.batch IS NULL OR EXISTS(SELECT FROM active_planner_batches b
  WHERE b.user_id=$1 AND b.batch_id=c.batch AND now()>=b.starts_at AND now()<b.ends_at))`;
const extended="EXISTS(SELECT FROM class_extensions x WHERE x.class=c.id AND x.student=$1 AND x.expires>now())";
async function attendance(tx:PoolClient,id:string,student:string) {
  const {rows}=await tx.query(`SELECT coalesce((SELECT sum(extract(epoch FROM upper(i)-lower(i)))::int FROM class_presence p,
    unnest(p.seen) i WHERE p.class=$1 AND p.student=$2),0) AS observed,
    (SELECT seconds FROM class_attendance_edits WHERE class=$1 AND student=$2 ORDER BY at DESC,id DESC LIMIT 1) AS corrected,
    (SELECT first_open FROM class_replay_views WHERE class=$1 AND student=$2) AS "firstReplayOpen"`,[id,student]);
  return rows[0];
}
export function registerClassrooms(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>,academic:Academic,origin:string) {
  const base="/api/v1/classes",staff="/api/v1/staff/classes";
  async function active(tx:PoolClient,student:string,id:string) {
    return (await tx.query(`SELECT c.kind,c.title,c.youtube_video_id,c.youtube_state,c.opens,c.closes FROM classes c WHERE c.id=$2 AND now()>=c.opens AND now()<c.closes AND ${eligible}`,
      [student,id])).rows[0]??fail(403);
  }
  app.post<Path>(base+"/:id/join",{schema:{params}},async req=>{
    const seat=await session(req,async(tx,a)=>({student:a.id,session:a.session,room:await active(tx,a.id,req.params.id)}));
    if(seat.room.youtube_video_id) return {provider:"youtube",joinUrl:base+"/"+req.params.id+"/watch",recording:null};
    if(!process.env.CLASSROOM_JOIN_URL) return fail(503);
    let joinUrl:string;
    try {
      const response=await fetch(process.env.CLASSROOM_JOIN_URL,{method:"POST",signal:AbortSignal.timeout(8000),redirect:"error",
        headers:{"Content-Type":"application/json",...(process.env.CLASSROOM_TOKEN?{Authorization:"Bearer "+process.env.CLASSROOM_TOKEN}:{})},
        body:JSON.stringify({classId:req.params.id,student:seat.student,kind:seat.room.kind,record:true})});
      if(!response.ok) return fail(503);
      const join=await response.json();
      if(join?.recording!==true || typeof join.joinUrl!=="string" || new URL(join.joinUrl).protocol!=="https:") return fail(503);
      joinUrl=join.joinUrl;
    } catch {return fail(503);}
    return session(req,async(tx,a)=>{
      if(a.session!==seat.session) fail(403);
      await active(tx,a.id,req.params.id);
      return {recording:true,joinUrl};
    });
  });
  app.post<Path & {Body:{id:string;kind:"chat"|"question";body:string}}>(base+"/:id/posts",{schema:{params,body:object({
    id:uuid,kind:{enum:["chat","question"]},body:text(2000)})}},req=>session(req,async(tx,a)=>{
    const c=await active(tx,a.id,req.params.id),b=req.body;
    const args=[b.id,req.params.id,a.id,b.kind,b.body];
    await tx.query("INSERT INTO class_posts(id,class,student,kind,body,approved) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      [...args,c.kind==="interactive"?true:null]);
    return (await tx.query("SELECT id,approved FROM class_posts WHERE (id,class,student,kind,body)=($1,$2,$3,$4,$5)",args)).rows[0]??fail(409);
  }));
  app.get<Path>(base+"/:id/discussion",{schema:{params}},req=>session(req,async(tx,a)=>{
    await active(tx,a.id,req.params.id);
    const args=[req.params.id,a.id];
    return {posts:(await tx.query(`SELECT id,kind,body,reply,approved,submitted FROM class_posts
      WHERE class=$1 AND (approved OR student=$2) ORDER BY submitted DESC,id LIMIT 200`,args)).rows,
      polls:(await tx.query(`SELECT p.id,title,choices,closes,v.choice FROM class_polls p LEFT JOIN class_votes v ON v.poll=p.id AND v.student=$2
        WHERE class=$1 ORDER BY closes,id`,args)).rows};
  }));
  app.get<Path>(staff+"/:id/discussion",{schema:{params}},req=>academic(req,async tx=>({posts:(await tx.query(
    "SELECT * FROM class_posts WHERE class=$1 ORDER BY submitted DESC,id LIMIT 200",[req.params.id])).rows})));
  app.put<Path & {Body:{approved:boolean;reply:string}}>(staff+"/posts/:id",{schema:{params,body:object({approved:{type:"boolean"},reply:{type:"string",maxLength:2000}})}},
    req=>academic(req,async(tx,a)=>(await tx.query("UPDATE class_posts SET approved=$2,reply=$3,reviewer=$4 WHERE id=$1 RETURNING id,approved",
      [req.params.id,req.body.approved,req.body.reply,a])).rows[0]??fail(404)));
  app.post<Path & {Body:{id:string;title:string;choices:string[];closes:string}}>(staff+"/:id/polls",{schema:{params,body:object({
    id:uuid,title:text(200),choices:{type:"array",items:text(200),minItems:2,maxItems:12,uniqueItems:true},closes:instant})}},req=>academic(req,async(tx,a)=>{
    const b=req.body;
    return (await tx.query(`INSERT INTO class_polls SELECT $1,c.id,$3,$4,$5,$6 FROM classes c WHERE c.id=$2
      AND now()<$6::timestamptz AND $6<=c.closes RETURNING id`,[b.id,req.params.id,b.title,JSON.stringify(b.choices),a,b.closes])).rows[0]??fail(422);
  }));
  app.put<{Params:{id:string;poll:string};Body:{choice:number}}>(base+"/:id/polls/:poll",{schema:{params:object({id:uuid,poll:uuid}),
    body:object({choice:{type:"integer",minimum:0,maximum:11}})}},req=>session(req,async(tx,a)=>{
    await active(tx,a.id,req.params.id);
    return (await tx.query(`INSERT INTO class_votes SELECT p.id,$2,$3 FROM class_polls p WHERE p.id=$1 AND p.class=$4 AND p.closes>now()
      AND jsonb_array_length(p.choices)>$3 ON CONFLICT(poll,student) DO UPDATE SET choice=excluded.choice RETURNING choice`,
      [req.params.poll,a.id,req.body.choice,req.params.id])).rows[0]??fail(409);
  }));
  app.get<Path>(base+"/:id/watch",{schema:{params}},async(req,reply)=>{
    if(!origin || req.host!==new URL(origin).host) fail(403);
    const page=await session(req,async(tx,a)=>{
      const room=await active(tx,a.id,req.params.id);
      if(!room.youtube_video_id) fail(404);
      const viewer=await mediaViewer(tx,a.id);
      return youtubeClassPage(room.title,viewer,origin,room.youtube_state==="live"?room.youtube_video_id:null,viewingSession(a.session,req.params.id));
    });
    return reply.header("Content-Security-Policy",page.policy)
      .header("Referrer-Policy","strict-origin-when-cross-origin").type("text/html; charset=utf-8").send(page.html);
  });
  app.put<Path & {Body:{phone:string}}>(base+"/:id/watermark-phone",{schema:{params,body:object({phone:{type:"string",pattern:"^\\+[1-9][0-9]{7,14}$"}})}},req=>session(req,async(tx,a)=>{
    const room=await active(tx,a.id,req.params.id);
    if(!room.youtube_video_id) fail(404);
    await tx.query("INSERT INTO classroom_identity VALUES ($1,$2) ON CONFLICT(student) DO UPDATE SET phone=excluded.phone",[a.id,req.body.phone]);
    return {saved:true};
  }));
  type Class={id:string;product:string;batch?:string;title:string;kind:"broadcast"|"interactive";opens:string;closes:string;youtubeVideoId?:string};
  app.post<{Body:Class}>(staff,{schema:{body:object({id:uuid,product:text(120),batch:uuid,title:text(200),kind:{enum:["broadcast","interactive"]},
    opens:instant,closes:instant,youtubeVideoId:{type:"string",pattern:"^[A-Za-z0-9_-]{11}$",maxLength:11}},["id","product","title","kind","opens","closes"])}},req=>academic(req,async(tx,a)=>{
    const b=req.body;
    if(Date.parse(b.opens)>=Date.parse(b.closes)) fail(422);
    if(b.youtubeVideoId && b.kind!=="broadcast") fail(422);
    await tx.query("INSERT INTO classes(id,product,batch,title,kind,opens,closes,author,youtube_video_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [b.id,b.product,b.batch,b.title,b.kind,b.opens,b.closes,a,b.youtubeVideoId??null]);
    return {id:b.id,recordingRequired:true};
  }));
  app.get(base,req=>session(req,async(tx,a)=>({classes:(await tx.query(`SELECT c.id,c.title,c.kind,c.opens,c.closes,true AS "recordingRequired",
    c.replay IS NOT NULL AND now()>=c.closes AS "replayAvailable" FROM classes c WHERE (${eligible}) OR
    (c.replay IS NOT NULL AND now()>=c.closes AND ${extended}) ORDER BY c.opens,c.id`,[a.id])).rows})));
  app.post<Path>(base+"/:id/presence",{schema:{params}},req=>session(req,async(tx,a)=>{
    const expected=req.headers["x-class-session"];
    if(expected!==undefined && expected!==viewingSession(a.session,req.params.id)) fail(403);
    // Join establishes a timestamp. Subsequent online heartbeats confirm only short contiguous intervals.
    const result=await tx.query(`INSERT INTO class_presence(class,student,last_seen)
      SELECT c.id,$1,now() FROM classes c WHERE c.id=$2 AND c.opens<=now() AND now()<c.closes AND ${eligible}
      ON CONFLICT(class,student) DO UPDATE SET seen=class_presence.seen+CASE WHEN excluded.last_seen>=class_presence.last_seen
        AND excluded.last_seen-class_presence.last_seen<=interval '60 seconds'
        THEN tstzmultirange(tstzrange(class_presence.last_seen,excluded.last_seen)) ELSE '{}'::tstzmultirange END,
        last_seen=greatest(class_presence.last_seen,excluded.last_seen) RETURNING last_seen`,[a.id,req.params.id]);
    if(!result.rowCount) fail(403);
    const network=createHmac("sha256",a.session).update(req.ip).digest("hex");
    await tx.query(`INSERT INTO classroom_network AS n(session_id,last_network,seen) VALUES ($1,$2,now())
      ON CONFLICT(session_id) DO UPDATE SET last_network=excluded.last_network,seen=now(),
      prior_network=CASE WHEN n.last_network<>excluded.last_network THEN n.last_network ELSE n.prior_network END,
      prior_seen=CASE WHEN n.last_network<>excluded.last_network THEN n.seen ELSE n.prior_seen END,
      flagged_at=CASE WHEN n.last_network<>excluded.last_network AND n.prior_network=excluded.last_network
        AND n.prior_seen>now()-interval '90 seconds' THEN now() ELSE n.flagged_at END`,[a.session,network]);
    return result.rows[0];
  }));
  app.get<Path>(base+"/:id/attendance",{schema:{params}},req=>session(req,(tx,a)=>attendance(tx,req.params.id,a.id)));
  app.get<{Params:{id:string;student:string}}>("/api/v1/mentor/classes/:id/attendance/:student",{schema:{params:object({id:uuid,student:text(200)})}},
    req=>session(req,async(tx,a)=>{
      if(!(await tx.query("SELECT FROM active_mentors WHERE student_id=$1 AND mentor_id=$2",[req.params.student,a.id])).rowCount) fail(403);
      return attendance(tx,req.params.id,req.params.student);
    }));
  app.get<{Params:{id:string;student:string}}>(staff+"/:id/attendance/:student",{schema:{params:object({id:uuid,student:text(200)})}},
    req=>academic(req,async tx=>({...await attendance(tx,req.params.id,req.params.student),edits:(await tx.query(
      "SELECT id,seconds,reason,reviewer,at FROM class_attendance_edits WHERE class=$1 AND student=$2 ORDER BY at,id",[req.params.id,req.params.student])).rows})));
  app.put<Path & {Body:{id:string;student:string;seconds:number;reason:string}}>(staff+"/:id/attendance",{schema:{params,body:object({
    id:uuid,student:text(200),seconds:{type:"integer",minimum:0},reason:text(2000)})}},req=>academic(req,async(tx,reviewer)=>{
    const b=req.body,args=[b.id,req.params.id,b.student,b.seconds,b.reason,reviewer];
    await tx.query(`INSERT INTO class_attendance_edits(id,class,student,seconds,reason,reviewer)
      SELECT $1,c.id,$3,$4,$5,$6 FROM classes c WHERE c.id=$2 AND $4::int<=extract(epoch FROM c.closes-c.opens)
      ON CONFLICT DO NOTHING`,args);
    return (await tx.query(`SELECT id,at FROM class_attendance_edits WHERE (id,class,student,seconds,reason,reviewer)=($1,$2,$3,$4,$5,$6)`,args)).rows[0]??fail(409);
  }));
  app.put<Path & {Body:{assetId:string}}>(staff+"/:id/replay",{schema:{params,body:object({assetId:uuid})}},req=>academic(req,async tx=>{
    return (await tx.query("UPDATE classes SET replay=$2 WHERE id=$1 AND closes<=now() RETURNING id",[req.params.id,req.body.assetId])).rows[0]??fail(409);
  }));
  app.put<Path & {Body:{student:string;expires:string;reason:string}}>(staff+"/:id/extension",{schema:{params,body:object({
    student:text(200),expires:instant,reason:text(2000)})}},req=>academic(req,async(tx,a)=>{
    await tx.query(`INSERT INTO class_extensions VALUES ($1,$2,$3,$4,$5) ON CONFLICT(class,student) DO UPDATE
      SET expires=excluded.expires,reviewer=excluded.reviewer,reason=excluded.reason`,[req.params.id,req.body.student,req.body.expires,a,req.body.reason]);
    return {expires:req.body.expires};
  }));
  async function replayAsset(tx:PoolClient,student:string,id:string):Promise<string>{
    return ((await tx.query(`SELECT replay FROM classes c WHERE c.id=$2 AND now()>=c.closes AND replay IS NOT NULL
      AND ((${eligible}) OR ${extended})`,[student,id])).rows[0]??fail(404)).replay;
  }
  app.get<Path>(base+"/:id/replay/watch",{schema:{params}},async(req,reply)=>{
    const page=await recordedPage(req,session,(tx,user)=>replayAsset(tx,user,req.params.id));
    return reply.header("Content-Security-Policy",page.policy).type("text/html; charset=utf-8").send(page.html);
  });
  app.post<Path>(base+"/:id/replay",{schema:{params}},req=>session(req,async(tx,a)=>{
    const assetId=await replayAsset(tx,a.id,req.params.id);
    await tx.query("INSERT INTO class_replay_views(class,student) VALUES ($1,$2) ON CONFLICT DO NOTHING",[req.params.id,a.id]);
    return {assetId,watchHref:base+"/"+req.params.id+"/replay/watch"};
  }));
}
