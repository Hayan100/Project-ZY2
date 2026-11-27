import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, type sessionTransaction } from "./authorized.ts";

const uuid={type:"string",format:"uuid"};
const label=(maxLength:number)=>({type:"string",maxLength,pattern:"\\S"});
const number=(minimum:number,maximum:number)=>({type:"integer",minimum,maximum});
const instant={type:"string",format:"date-time",pattern:"(Z|[+-][0-9]{2}:[0-9]{2})$"};
const object=(properties:Record<string,object>,required=Object.keys(properties))=>({type:"object",properties,required,additionalProperties:false});
const params=object({id:uuid});
type Path={Params:{id:string}};
type Family={id:string;name:string;mentor_id:string;product_key:string;batch_id:string|null};
const weekStart="date_trunc('week',now() AT TIME ZONE 'Asia/Karachi')::date";
const sameCohort="f.product_key=other.product_key AND f.batch_id IS NOT DISTINCT FROM other.batch_id";
async function member(tx:PoolClient,id:string,user:string) {
  return (await tx.query<Family>("SELECT f.* FROM families f JOIN family_members m ON m.family_id=f.id WHERE f.id=$1 AND m.user_id=$2",[id,user])).rows[0] ?? fail(404);
}
async function admin(tx:PoolClient,user:string) {
  if(!(await tx.query("SELECT FROM welcome_admins WHERE user_id=$1",[user])).rowCount) fail(403);
}
async function manager(tx:PoolClient,family:string,user:string) {
  if(!(await tx.query(`SELECT FROM families f WHERE f.id=$1 AND (f.created_by=$2 OR EXISTS
    (SELECT FROM family_staff s WHERE s.family_id=f.id AND s.user_id=$2))`,[family,user])).rowCount) fail(403);
}
async function eventManager(tx:PoolClient,event:string,user:string) {
  const row=(await tx.query("SELECT home,away FROM family_events WHERE id=$1",[event])).rows[0] ?? fail(404);
  await manager(tx,row.home,user);
  await manager(tx,row.away,user);
}
async function lock(tx:PoolClient,id:string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,19))",[id]);
}
const activeCaptain=`FROM family_captains c JOIN family_students s ON s.family_id=c.family_id AND s.user_id=c.student_id
  AND s.assigned_at<=c.volunteered_at WHERE c.family_id=$1 AND c.approved_at IS NOT NULL AND c.ends_at>now() AND c.stepped_down_at IS NULL`;
async function roster(tx:PoolClient,family:string) {
  return (await tx.query(`SELECT m.user_id AS id,u.name,m.user_id=f.mentor_id AS ghazi,p.last_active AS "lastActive",
    coalesce(p.last_active>now()-interval '5 minutes',false) AS online,
    CASE WHEN p.sharing AND NOT p.focused AND p.last_active>now()-interval '5 minutes' THEN p.activity END AS activity,
    CASE WHEN p.sharing AND NOT p.focused AND p.last_active>now()-interval '5 minutes' THEN p.subject END AS subject
    FROM family_members m JOIN families f ON f.id=m.family_id JOIN "user" u ON u.id=m.user_id
    LEFT JOIN family_presence p ON p.user_id=m.user_id WHERE m.family_id=$1 ORDER BY ghazi DESC,u.name,m.user_id`,[family])).rows;
}
async function mine(tx:PoolClient,user:string) {
  return (await tx.query(`SELECT f.id,f.name,f.mentor_id AS "mentorId" FROM families f JOIN family_members m ON m.family_id=f.id
    WHERE m.user_id=$1 ORDER BY f.name,f.id`,[user])).rows;
}
async function focused(tx:PoolClient,user:string) {
  return !!(await tx.query("SELECT FROM family_presence WHERE user_id=$1 AND focused",[user])).rowCount;
}
export async function familyStrip(tx:PoolClient,user:string) {
  if(await focused(tx,user)) return [];
  const strip=[];
  for(const f of await mine(tx,user)) strip.push({...f,members:await roster(tx,f.id),url:"/api/v1/families/"+f.id});
  return strip;
}
async function weekly(tx:PoolClient,family:string) {
  const counts=(await tx.query(`WITH members AS (SELECT user_id,min(assigned_at) AS joined FROM family_students WHERE family_id=$1 GROUP BY user_id)
    SELECT m.user_id AS "memberId",count(t.id)::int AS "completedTasks" FROM members m LEFT JOIN planner_tasks t
    ON t.student_id=m.user_id AND t.completed_at>=greatest(m.joined,(${weekStart}::timestamp AT TIME ZONE 'Asia/Karachi'))
    AND t.completed_at<=now() GROUP BY m.user_id ORDER BY m.user_id`,[family])).rows;
  const goal=(await tx.query(`SELECT week::text,title,target,version FROM family_goals WHERE family_id=$1 AND week=${weekStart}`,[family])).rows[0] ?? null;
  return {goal,activity:counts,completedTasks:counts.reduce((n,c)=>n+c.completedTasks,0)};
}
async function hall(tx:PoolClient,family:string) {
  const awards=(await tx.query(`SELECT id,student_id AS "memberId",title,kind,awarded_at AS "awardedAt" FROM family_awards
    WHERE family_id=$1 ORDER BY awarded_at DESC,id`,[family])).rows;
  const leaderboard=(await tx.query(`WITH scores AS (
    SELECT f.id,f.name,sum(CASE WHEN e.home=f.id THEN e.home_points ELSE e.away_points END)::int AS points
    FROM families other JOIN families f ON ${sameCohort} JOIN family_events e ON f.id IN(e.home,e.away)
    WHERE other.id=$1 AND e.ranked_by IS NOT NULL AND e.recorded_by IS NOT NULL GROUP BY f.id)
    SELECT id,name,points,dense_rank() OVER(ORDER BY points DESC)::int AS rank FROM scores ORDER BY rank,name,id`,[family])).rows;
  return {week:await weekly(tx,family),awards,leaderboard};
}
export function registerFamilies(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>) {
  const base="/api/v1/families/:id",staff="/api/v1/staff/families";
  app.post<{Body:{id:string;name:string;mentorId:string;productKey:string;batchId?:string}}>(staff,{schema:{body:object({
    id:uuid,name:label(120),mentorId:label(200),productKey:label(120),batchId:uuid},["id","name","mentorId","productKey"])}},
    req=>session(req,async(tx,a)=>{
      await admin(tx,a.id);
      const b=req.body;
      if(!(await tx.query("SELECT FROM ghazis WHERE user_id=$1",[b.mentorId])).rowCount) fail(404);
      if(b.batchId && !(await tx.query("SELECT FROM payment_offers WHERE batch_id=$1 AND product_key=$2",[b.batchId,b.productKey])).rowCount) fail(422);
      await tx.query("INSERT INTO families(id,name,mentor_id,product_key,batch_id,created_by) VALUES($1,$2,$3,$4,$5,$6)",[b.id,b.name,b.mentorId,b.productKey,b.batchId,a.id]);
      return {id:b.id};
    }));
  app.put<Path & {Body:{memberId:string;restricted:boolean}}>(staff+"/:id/restrictions",{
    schema:{params,body:object({memberId:label(200),restricted:{type:"boolean"}})}
  },req=>session(req,async(tx,a)=>{
    await manager(tx,req.params.id,a.id);
    const b=req.body;
    if(!(await tx.query('SELECT FROM "user" WHERE id=$1',[b.memberId])).rowCount) fail(404);
    await tx.query(`INSERT INTO family_restrictions(family_id,user_id,restricted,changed_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(family_id,user_id) DO UPDATE SET restricted=excluded.restricted,changed_by=excluded.changed_by,changed_at=now()`,
      [req.params.id,b.memberId,b.restricted,a.id]);
    return {restricted:b.restricted};
  }));
  app.get("/api/v1/me/families",req=>session(req,async(tx,a)=>{
    const families=await mine(tx,a.id);
    return {families,eligibility:families.length?"member":"An active family-enabled enrollment and confirmed Ghazi assignment are required."};
  }));
  app.put<{Body:{sharing:boolean;focused:boolean;activity?:string;subject?:string}}>("/api/v1/me/family-presence",{
    schema:{body:object({sharing:{type:"boolean"},focused:{type:"boolean"},activity:{enum:["studying","lecture","reading","practice","revision","break"]},
      subject:{enum:["Biology","Chemistry","Physics","English","Logical Reasoning","Other"]}},["sharing","focused"])}
  },req=>session(req,async(tx,a)=>{
    const b=req.body;
    await tx.query(`INSERT INTO family_presence VALUES($1,now(),$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET last_active=now(),
      sharing=excluded.sharing,focused=excluded.focused,activity=excluded.activity,subject=excluded.subject`,
      [a.id,b.sharing,b.focused,b.sharing?b.activity:null,b.sharing && b.activity && b.activity!=="break"?b.subject:null]);
    return {sharing:b.sharing,focused:b.focused};
  }));
  app.get<Path>(base,{schema:{params}},req=>session(req,async(tx,a)=>{
    const f=await member(tx,req.params.id,a.id);
    const muted=await focused(tx,a.id);
    const own=(await tx.query(`SELECT s.enrollment_id,
      (SELECT next_checkin FROM ghazi_followups WHERE enrollment_id=s.enrollment_id AND assignment_version=g.version ORDER BY created_at DESC,id LIMIT 1) AS next_checkin
      FROM family_students s JOIN current_ghazis g USING(enrollment_id) WHERE family_id=$1 AND user_id=$2 ORDER BY s.assigned_at DESC LIMIT 1`,[f.id,a.id])).rows[0];
    return {id:f.id,name:f.name,mentorId:f.mentor_id,members:muted?[]:await roster(tx,f.id),week:await weekly(tx,f.id),
      captain:(await tx.query('SELECT c.student_id AS "memberId",c.ends_at AS "endsAt" '+activeCaptain,[f.id])).rows[0] ?? null,
      ghaziContact:own?{url:"/api/v1/onboarding/"+own.enrollment_id+"/messages",nextCheckin:own.next_checkin}:null,
      latestMessages:muted?[]:(await tx.query("SELECT id,author,body,created_at FROM family_messages WHERE family_id=$1 ORDER BY created_at DESC,id DESC LIMIT 3",[f.id])).rows,
      recentAwards:(await tx.query('SELECT id,title,kind,student_id AS "memberId" FROM family_awards WHERE family_id=$1 ORDER BY awarded_at DESC,id LIMIT 3',[f.id])).rows,
      messagesUrl:muted?null:"/api/v1/families/"+f.id+"/messages",hallUrl:"/api/v1/families/"+f.id+"/hall"};
  }));
  app.get<Path>(base+"/hall",{schema:{params}},req=>session(req,async(tx,a)=>{
    const f=await member(tx,req.params.id,a.id);
    return hall(tx,f.id);
  }));
  app.post<Path & {Body:{id:string;text:string}}>(base+"/messages",{schema:{params,body:object({id:uuid,text:label(4000)})}},
    req=>session(req,async(tx,a)=>{
      const f=await member(tx,req.params.id,a.id);
      if(await focused(tx,a.id)) fail(409);
      const b=req.body;
      const inserted=await tx.query("INSERT INTO family_messages(id,family_id,author,body) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[b.id,f.id,a.id,b.text]);
      if(!inserted.rowCount && !(await tx.query("SELECT FROM family_messages WHERE id=$1 AND family_id=$2 AND author=$3 AND body=$4",[b.id,f.id,a.id,b.text])).rowCount) fail(409);
      return {id:b.id};
    }));
  app.get<Path & {Querystring:{before?:string}}>(base+"/messages",{schema:{params,querystring:object({before:uuid},[])}},req=>session(req,async(tx,a)=>{
    const f=await member(tx,req.params.id,a.id);
    if(await focused(tx,a.id)) return {messages:[]};
    const rows=await tx.query(`SELECT id,author,body,created_at FROM family_messages WHERE family_id=$1 AND
      ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM family_messages WHERE family_id=$1 AND id=$2))
      ORDER BY created_at DESC,id DESC LIMIT 50`,[f.id,req.query.before]);
    return {messages:rows.rows};
  }));
  app.put<Path & {Body:{recipient:string}}>(base+"/nudges",{schema:{params,body:object({recipient:label(200)})}},req=>session(req,async(tx,a)=>{
    const f=await member(tx,req.params.id,a.id),to=req.body.recipient;
    if(to===a.id) fail(400);
    await member(tx,f.id,to);
    if(await focused(tx,a.id)) fail(409);
    await tx.query(`INSERT INTO family_nudges(family_id,sender,recipient) VALUES($1,$2,$3)
      ON CONFLICT(family_id,sender,recipient) DO UPDATE SET sent_at=now() WHERE family_nudges.sent_at<now()-interval '1 hour'`,[f.id,a.id,to]);
    return {accepted:true};
  }));
  app.get<Path>(base+"/nudges",{schema:{params}},req=>session(req,async(tx,a)=>{
    const f=await member(tx,req.params.id,a.id);
    return {nudges:await focused(tx,a.id)?[]:(await tx.query(`SELECT n.sender,n.sent_at FROM family_nudges n JOIN family_members m
      ON m.family_id=n.family_id AND m.user_id=n.sender WHERE n.family_id=$1 AND n.recipient=$2 AND n.sent_at>now()-interval '1 day' ORDER BY n.sent_at DESC`,[f.id,a.id])).rows};
  }));
  app.put<Path & {Body:{title:string;target:number;version:number}}>(base+"/weekly-goal",{schema:{params,
    body:object({title:label(160),target:number(1,10000),version:number(0,2147483646)})}},req=>session(req,async(tx,a)=>{
    const f=await member(tx,req.params.id,a.id);
    if(f.mentor_id!==a.id) fail(403);
    await lock(tx,f.id);
    const b=req.body;
    const query=b.version===0?`INSERT INTO family_goals VALUES($1,${weekStart},$2,$3,1) ON CONFLICT DO NOTHING RETURNING version`:
      `UPDATE family_goals SET target=$2,title=$3,version=version+1 WHERE family_id=$1 AND week=${weekStart} AND version=$4 RETURNING version`;
    return (await tx.query(query,b.version===0?[f.id,b.target,b.title]:[f.id,b.target,b.title,b.version])).rows[0] ?? fail(409);
  }));
  app.post<Path & {Body:{id:string}}>(base+"/captain/volunteer",{schema:{params,body:object({id:uuid})}},req=>session(req,async(tx,a)=>{
    const f=await member(tx,req.params.id,a.id);
    if(f.mentor_id===a.id) fail(403);
    await lock(tx,f.id);
    const prior=(await tx.query(`SELECT c.id FROM family_captains c WHERE c.family_id=$1 AND student_id=$2 AND stepped_down_at IS NULL
      AND (ends_at IS NULL OR ends_at>now()) AND EXISTS(SELECT FROM family_students WHERE family_id=$1 AND user_id=$2 AND assigned_at<=c.volunteered_at)`,[f.id,a.id])).rows[0];
    if(prior) return prior;
    await tx.query("INSERT INTO family_captains(id,family_id,student_id) VALUES($1,$2,$3)",[req.body.id,f.id,a.id]);
    return {id:req.body.id};
  }));
  app.get<Path>(base+"/captain/volunteers",{schema:{params}},req=>session(req,async(tx,a)=>{
    const f=await member(tx,req.params.id,a.id);
    if(f.mentor_id!==a.id) fail(403);
    return {volunteers:(await tx.query(`SELECT DISTINCT c.id,c.student_id,c.volunteered_at FROM family_captains c JOIN family_students s
      ON s.family_id=c.family_id AND s.user_id=c.student_id AND s.assigned_at<=c.volunteered_at WHERE c.family_id=$1
      AND c.approved_at IS NULL AND c.stepped_down_at IS NULL ORDER BY c.volunteered_at,c.id`,[f.id])).rows};
  }));
  app.post<Path & {Body:{volunteerId:string;endsAt:string}}>(base+"/captain/approve",{schema:{params,body:object({volunteerId:uuid,endsAt:instant})}},
    req=>session(req,async(tx,a)=>{
      const f=await member(tx,req.params.id,a.id);
      if(f.mentor_id!==a.id) fail(403);
      await lock(tx,f.id);
      if((await tx.query("SELECT c.id "+activeCaptain,[f.id])).rowCount) fail(409);
      const result=await tx.query(`UPDATE family_captains c SET approved_at=now(),ends_at=$3 WHERE family_id=$1 AND id=$2
        AND approved_at IS NULL AND stepped_down_at IS NULL AND $3>now() AND EXISTS(SELECT FROM family_students s
        WHERE s.family_id=$1 AND s.user_id=c.student_id AND s.assigned_at<=c.volunteered_at) RETURNING id,student_id,ends_at`,
        [f.id,req.body.volunteerId,req.body.endsAt]);
      return result.rows[0] ?? fail(409);
    }));
  app.post<Path>(base+"/captain/step-down",{schema:{params}},req=>session(req,async(tx,a)=>{
    const f=await member(tx,req.params.id,a.id);
    await lock(tx,f.id);
    await tx.query("UPDATE family_captains SET stepped_down_at=now() WHERE family_id=$1 AND student_id=$2 AND stepped_down_at IS NULL",[f.id,a.id]);
    return {steppedDown:true};
  }));
  app.post<Path & {Body:{id:string;title:string;kind:string;memberId?:string}}>(staff+"/:id/awards",{schema:{params,
    body:object({id:uuid,title:label(160),kind:{enum:["achievement","trophy"]},memberId:label(200)},["id","title","kind"])}},
    req=>session(req,async(tx,a)=>{
      await manager(tx,req.params.id,a.id);
      const f=req.params.id,b=req.body;
      if(!(await tx.query("SELECT FROM families WHERE id=$1",[f])).rowCount) fail(404);
      if(b.memberId && !(await tx.query("SELECT FROM family_students WHERE family_id=$1 AND user_id=$2",[f,b.memberId])).rowCount) fail(422);
      await tx.query("INSERT INTO family_awards(id,family_id,student_id,title,kind,awarded_by) VALUES($1,$2,$3,$4,$5,$6)",
        [b.id,f,b.memberId,b.title,b.kind,a.id]);
      return {id:b.id};
    }));
  app.post<Path & {Body:{id:string;away:string;title:string;opensAt:string;closesAt:string}}>(base+"/challenges",{schema:{params,
    body:object({id:uuid,away:uuid,title:label(160),opensAt:instant,closesAt:instant})}},req=>session(req,async(tx,a)=>{
    const f=await member(tx,req.params.id,a.id),b=req.body;
    if(f.mentor_id!==a.id && !(await tx.query("SELECT c.id "+activeCaptain+" AND c.student_id=$2",[f.id,a.id])).rowCount) fail(403);
    if(b.away===f.id || Date.parse(b.opensAt)<=Date.now() || Date.parse(b.closesAt)<=Date.parse(b.opensAt)) fail(422);
    if(!(await tx.query(`SELECT FROM families f JOIN families other ON ${sameCohort} WHERE f.id=$1 AND other.id=$2`,[f.id,b.away])).rowCount) fail(404);
    await tx.query("INSERT INTO family_events(id,home,away,title,opens_at,closes_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [b.id,f.id,b.away,b.title,b.opensAt,b.closesAt,a.id]);
    return {id:b.id,ranked:false};
  }));
  app.get<Path>(base+"/challenges",{schema:{params}},req=>session(req,async(tx,a)=>{
    const f=await member(tx,req.params.id,a.id);
    const opponents=(await tx.query(`SELECT f.id,f.name FROM families f JOIN families other ON ${sameCohort} WHERE other.id=$1 AND f.id<>$1 ORDER BY f.name,f.id`,[f.id])).rows;
    return {opponents,challenges:(await tx.query(`SELECT e.id,e.home,e.away,e.title,e.opens_at,e.closes_at,e.ranked_by IS NOT NULL AS ranked,
      e.home_points,e.away_points,EXISTS(SELECT FROM family_entries p WHERE p.event_id=e.id AND p.user_id=$2 AND p.family_id=$1) AS joined
      FROM family_events e WHERE $1 IN(e.home,e.away) ORDER BY e.opens_at DESC,e.id`,[f.id,a.id])).rows};
  }));
  const eventParams=object({id:uuid,eventId:uuid});
  type EventPath={Params:{id:string;eventId:string}};
  app.put<EventPath & {Body:{join:boolean}}>(base+"/challenges/:eventId/entry",{schema:{params:eventParams,body:object({join:{type:"boolean"}})}},
    req=>session(req,async(tx,a)=>{
      const f=await member(tx,req.params.id,a.id),event=req.params.eventId;
      if(f.mentor_id===a.id) fail(403);
      await lock(tx,event);
      const row=(await tx.query("SELECT opens_at>clock_timestamp() AS accepting FROM family_events WHERE id=$1 AND $2 IN(home,away)",[event,f.id])).rows[0] ?? fail(404);
      if(!row.accepting) fail(409);
      if(req.body.join) {
        await tx.query(`INSERT INTO family_entries(event_id,user_id,family_id) VALUES($1,$2,$3) ON CONFLICT(event_id,user_id)
          DO UPDATE SET family_id=excluded.family_id,joined_at=now() WHERE family_entries.family_id<>excluded.family_id`,[event,a.id,f.id]);
      } else await tx.query("DELETE FROM family_entries WHERE event_id=$1 AND user_id=$2",[event,a.id]);
      return {joined:req.body.join};
    }));
  app.post<Path>(staff+"/challenges/:id/rank",{schema:{params}},req=>session(req,async(tx,a)=>{
    await eventManager(tx,req.params.id,a.id);
    const id=req.params.id;
    await lock(tx,id);
    const result=await tx.query(`UPDATE family_events SET ranked_by=$2,ranked_at=now() WHERE id=$1 AND ranked_by IS NULL
      AND opens_at>clock_timestamp() AND NOT EXISTS(SELECT FROM family_entries WHERE event_id=$1) RETURNING id`,[id,a.id]);
    return result.rows[0] ?? fail(409);
  }));
  app.put<Path & {Body:{homePoints:number;awayPoints:number}}>(staff+"/challenges/:id/result",{schema:{params,
    body:object({homePoints:number(0,1000000),awayPoints:number(0,1000000)})}},req=>session(req,async(tx,a)=>{
    await eventManager(tx,req.params.id,a.id);
    const id=req.params.id,b=req.body;
    await lock(tx,id);
    const row=(await tx.query("SELECT * FROM family_events WHERE id=$1",[id])).rows[0] ?? fail(404);
    if(row.recorded_by) {
      if(row.home_points!==b.homePoints || row.away_points!==b.awayPoints) fail(409);
    } else {
      const result=await tx.query(`UPDATE family_events e SET recorded_by=$2,home_points=$3,away_points=$4 WHERE id=$1 AND closes_at<=clock_timestamp()
        AND EXISTS(SELECT FROM family_entries WHERE event_id=e.id AND family_id=e.home)
        AND EXISTS(SELECT FROM family_entries WHERE event_id=e.id AND family_id=e.away) RETURNING id`,[id,a.id,b.homePoints,b.awayPoints]);
      if(!result.rowCount) fail(409);
    }
    return {id,...b};
  }));
}
