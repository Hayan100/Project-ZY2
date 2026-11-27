import type {FastifyInstance} from "fastify";
import type {PoolClient} from "pg";
import {fail,type sessionTransaction} from "./authorized.ts";
import {loadCourse} from "./learning.ts";
import {registerLibrary} from "./virtual-library.ts";

export const uuid={type:"string",format:"uuid"};
export const label=(maxLength:number)=>({type:"string",pattern:"\\S",maxLength});
export const obj=(properties:Record<string,object>,required=Object.keys(properties))=>({type:"object",properties,required,additionalProperties:false});
export const params=obj({id:uuid});
export type Path={Params:{id:string}};
export type Session=ReturnType<typeof sessionTransaction>;
export async function moderator(tx:PoolClient,user:string) {
  if(!(await tx.query("SELECT FROM community_moderators WHERE user_id=$1",[user])).rowCount) fail(403);
}
export async function allowed(tx:PoolClient,user:string,write=false) {
  if((await tx.query(`SELECT FROM live_focus WHERE player=$1 UNION ALL SELECT FROM community_limits WHERE subject=$1
    AND (kind='restrict' OR $2)`,[user,write])).rowCount) fail(403);
}
export async function blocked(tx:PoolClient,a:string,b:string) {
  return !!(await tx.query("SELECT FROM community_blocks WHERE (actor,peer) IN (($1,$2),($2,$1))",[a,b])).rowCount;
}
async function stoat(channel:string,id?:string,input?:{id:string;text:string}) {
  const base=process.env.STOAT_API_URL,token=process.env.STOAT_BOT_TOKEN;
  if(!base || !token) fail(503);
  let endpoint:URL;
  try {endpoint=new URL(base);} catch{ return fail(503); }
  if(endpoint.protocol!=="https:" && !(endpoint.protocol==="http:" && ["localhost","127.0.0.1","[::1]"].includes(endpoint.hostname))) fail(503);
  const headers:Record<string,string>={"x-bot-token":token};
  if(input){headers["Content-Type"]="application/json";headers["Idempotency-Key"]=input.id;}
  const response=await fetch(base.replace(/\/$/,"")+"/channels/"+encodeURIComponent(channel)+"/messages"+(id?"/"+encodeURIComponent(id):""),{
    headers,method:input?"POST":"GET",body:input?JSON.stringify({content:input.text,nonce:input.id}):undefined,
    redirect:"error",signal:AbortSignal.timeout(3500)
  }).catch(()=>fail(503));
  if(!response.ok) fail(503);
  const message=await response.json() as {_id:string;content:string;channel:string};
  if(message.channel!==channel || typeof message.content!=="string" || typeof message._id!=="string" || (id && message._id!==id)) fail(502);
  return message;
}

export function registerCommunity(app:FastifyInstance,session:Session,accessible:string) {
  const root="/api/v1/community",staff="/api/v1/staff/community",channel=root+"/channels/:id";
  const field={name:label(100),kind:{enum:["announcements","academic","general","media","resources","quiet","social"]},subject:label(80),
    product:label(120),batch:uuid,family:uuid,invitation:{type:"boolean"},course:uuid,lesson:uuid,stoatChannel:{type:"string",pattern:"^[0-9A-HJKMNP-TV-Z]{26}$"},
    capacity:{type:"integer",minimum:1,maximum:24},instances:{type:"integer",minimum:1,maximum:16}};
  type Space={name:string;kind:string;subject?:string;product?:string;batch?:string;family?:string;invitation?:boolean;course?:string;lesson?:string;stoatChannel?:string;capacity?:number;instances?:number};
  app.post<{Body:Space & {id:string}}>(staff+"/spaces",{schema:{body:obj({id:uuid,...field},["id","name","kind"])}},req=>session(req,async(tx,a)=>{
    await moderator(tx,a.id);
    const b=req.body,room=["quiet","social"].includes(b.kind);
    if(room!==!!b.capacity || room!==!!b.instances || (!room && b.invitation) || !!b.course!==!!b.lesson ||
      (b.kind==="academic")!==!!b.subject || ((b.invitation||b.batch)&&!b.product) || (room&&b.course) ||
      (b.stoatChannel && !["general","media"].includes(b.kind))) fail(422);
    if(b.family && !(await tx.query("SELECT FROM families WHERE id=$1",[b.family])).rowCount) fail(422);
    if(b.batch && !(await tx.query("SELECT FROM admission_batches WHERE id=$1",[b.batch])).rowCount) fail(422);
    if(b.course && !(await tx.query(`SELECT FROM courses c JOIN course_revisions r ON (r.course_id,r.revision)=(c.id,c.published_revision)
      CROSS JOIN jsonb_array_elements(r.outline->'chapters') ch CROSS JOIN jsonb_array_elements(ch->'lessons') l WHERE c.id=$1 AND l->>'id'=$2`,[b.course,b.lesson])).rowCount) fail(422);
    await tx.query(`INSERT INTO shared_spaces(id,name,kind,subject,product,batch,family,invitation,course,lesson,stoat_channel,capacity,instances)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[b.id,b.name,b.kind,b.subject,b.product,b.batch,b.family,b.invitation??false,b.course,b.lesson,b.stoatChannel,b.capacity,b.instances]);
    return {id:b.id};
  }));
  app.put<Path & {Body:{channel:string}}>(staff+"/spaces/:id/stoat",{schema:{params,body:obj({channel:field.stoatChannel})}},req=>session(req,async(tx,a)=>{
    await moderator(tx,a.id);
    return (await tx.query("UPDATE shared_spaces SET stoat_channel=$2 WHERE id=$1 AND kind IN('general','media') AND (stoat_channel IS NULL OR stoat_channel=$2) RETURNING id",[req.params.id,req.body.channel])).rows[0]??fail(409);
  }));
  async function visible(tx:PoolClient,user:string,id?:string) {
    await allowed(tx,user);
    const rows=(await tx.query(`SELECT s.*,EXISTS(SELECT FROM space_follows f WHERE f.space=s.id AND f.actor=$1) AS followed
      FROM shared_spaces s JOIN space_access a USING(id) WHERE a.actor=$1 AND s.capacity IS NULL AND ($2::uuid IS NULL OR s.id=$2) ORDER BY s.name,s.id`,[user,id])).rows;
    const result=[];
    for(const s of rows) {
      if(s.course) {
        try {(await loadCourse(tx,accessible,user,s.course)).available(s.lesson);}
        catch(err){if([403,404].includes((err as {statusCode:number}).statusCode)) continue;throw err;}
      }
      result.push(s);
    }
    return result;
  }
  async function getChannel(tx:PoolClient,user:string,id:string) {return (await visible(tx,user,id))[0] ?? fail(404);}
  async function peer(tx:PoolClient,user:string,id:string) {
    await allowed(tx,user);
    const r=(await tx.query("SELECT * FROM peer_requests WHERE id=$1 AND $2 IN(sender,recipient) AND accepted",[id,user])).rows[0] ?? fail(404);
    if(await blocked(tx,r.sender,r.recipient)) fail(404);
  }
  async function posts(tx:PoolClient,scope:string,id:string,user:string,search?:string,before?:string) {
    const rows=(await tx.query(`SELECT p.id,p.author,p.body,p.remote_id,p.created,p.parent,p.verified_by,s.stoat_channel FROM community_posts p
      LEFT JOIN shared_spaces s ON s.id=p.space WHERE p.${scope}=$1 AND NOT p.removed AND
      NOT EXISTS(SELECT FROM community_blocks WHERE (actor,peer) IN (($2,p.author),(p.author,$2))) AND
      ($3::text IS NULL OR strpos(lower(p.body),lower($3))>0) AND ($4::uuid IS NULL OR (p.created,p.id)<
      (SELECT created,id FROM community_posts WHERE id=$4 AND ${scope}=$1)) ORDER BY p.created DESC,p.id DESC LIMIT 30`,[id,user,search,before])).rows;
    return Promise.all(rows.map(async({remote_id,stoat_channel,...p})=>({...p,body:remote_id?(await stoat(stoat_channel,remote_id)).content:p.body})));
  }
  app.get(root,req=>session(req,async(tx,a)=>{
    const channels=(await visible(tx,a.id)).map(({stoat_channel,...s})=>s);
    const families=(await tx.query("SELECT f.id,f.name FROM families f JOIN family_members m ON m.family_id=f.id WHERE m.user_id=$1",[a.id])).rows;
    const mentors=(await tx.query("SELECT id,mentor_id FROM welcome_enrollments WHERE user_id=$1 AND mentor_id IS NOT NULL",[a.id])).rows;
    const announcements=[];
    for(const c of channels.filter(c=>c.kind==="announcements")) announcements.push(...await posts(tx,"space",c.id,a.id));
    return {announcements:announcements.sort((a,b)=>b.created-a.created).slice(0,30),followed:channels.filter(c=>c.followed),channels,families,
      familyEligibility:families.length?null:"An active family-enabled enrollment and Ghazi assignment are required.",library:"/api/v1/library",mentors:mentors.map(m=>"/api/v1/onboarding/"+m.id+"/messages"),
      support:process.env.COMMUNITY_SUPPORT_URL??"/api/v1/support/tickets"};
  }));
  app.put<Path & {Body:{follow:boolean}}>(channel+"/follow",{schema:{params,body:obj({follow:{type:"boolean"}})}},req=>session(req,async(tx,a)=>{
    const id=req.params.id;await getChannel(tx,a.id,id);
    if(req.body.follow) await tx.query("INSERT INTO space_follows VALUES($1,$2) ON CONFLICT DO NOTHING",[id,a.id]);
    else await tx.query("DELETE FROM space_follows WHERE space=$1 AND actor=$2",[id,a.id]);
    return {followed:req.body.follow};
  }));
  const dm=root+"/dms/:id";
  for(const [url,scope] of [[channel,"space"],[dm,"dm"]] as const) {
    app.get<Path & {Querystring:{q?:string;before?:string}}>(url+"/posts",{schema:{params,querystring:obj({q:label(150),before:uuid},[])}},req=>session(req,async(tx,a)=>{
      const id=req.params.id;
      if(scope==="space") await getChannel(tx,a.id,id); else await peer(tx,a.id,id);
      return {posts:await posts(tx,scope,id,a.id,req.query.q,req.query.before)};
    }));
    app.post<Path & {Body:{id:string;text:string;parent?:string}}>(url+"/posts",{schema:{params,body:obj({id:uuid,text:label(2000),parent:uuid},["id","text"])}},req=>session(req,async(tx,a)=>{
      const id=req.params.id,b=req.body;
      await allowed(tx,a.id,true);
      const c=scope==="space"?await getChannel(tx,a.id,id):null;
      if(scope==="dm") await peer(tx,a.id,id);
      if(c?.kind==="announcements") await moderator(tx,a.id);
      if(b.parent && !(await tx.query(`SELECT FROM community_posts WHERE id=$1 AND ${scope}=$2 AND NOT removed AND parent IS NULL`,[b.parent,id])).rowCount) fail(404);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,41))",[b.id]);
      const old=(await tx.query(`SELECT author,${scope} AS destination FROM community_posts WHERE id=$1`,[b.id])).rows[0];
      if(old){if(old.author!==a.id||old.destination!==id) fail(409);return {id:b.id};}
      if(c && ["general","media"].includes(c.kind) && !c.stoat_channel) fail(503);
      const remote=c?.stoat_channel?await stoat(c.stoat_channel,undefined,b):null;
      await tx.query(`INSERT INTO community_posts(id,${scope},author,body,remote_id,parent) VALUES($1,$2,$3,$4,$5,$6)`,[b.id,id,a.id,remote?null:b.text,remote?._id,b.parent]);
      return {id:b.id};
    }));
  }
  app.post<{Body:{peer:string}}>(root+"/dms",{schema:{body:obj({peer:label(200)})}},req=>session(req,async(tx,a)=>{
    const other=req.body.peer;await allowed(tx,a.id,true);
    if(other===a.id||await blocked(tx,a.id,other)||!(await tx.query('SELECT FROM "user" WHERE id=$1',[other])).rowCount) fail(404);
    await tx.query("INSERT INTO peer_requests(sender,recipient) VALUES($1,$2) ON CONFLICT DO NOTHING",[a.id,other]);
    return (await tx.query("SELECT id,accepted FROM peer_requests WHERE (sender,recipient) IN (($1,$2),($2,$1))",[a.id,other])).rows[0];
  }));
  app.get(root+"/dms",req=>session(req,async(tx,a)=>{
    await allowed(tx,a.id);
    return {requests:(await tx.query(`SELECT * FROM peer_requests p WHERE $1 IN(sender,recipient) AND NOT EXISTS
      (SELECT FROM community_blocks WHERE (actor,peer) IN ((sender,recipient),(recipient,sender)))`,[a.id])).rows};
  }));
  app.put<Path>(dm+"/accept",{schema:{params}},req=>session(req,async(tx,a)=>{
    await allowed(tx,a.id,true);
    return (await tx.query(`UPDATE peer_requests SET accepted=true WHERE id=$1 AND recipient=$2 AND NOT EXISTS
      (SELECT FROM community_blocks WHERE (actor,peer) IN ((sender,recipient),(recipient,sender))) RETURNING id`,[req.params.id,a.id])).rows[0]??fail(404);
  }));
  app.put<{Body:{peer:string;block:boolean}}>(root+"/block",{schema:{body:obj({peer:label(200),block:{type:"boolean"}})}},req=>session(req,async(tx,a)=>{
    const b=req.body;
    if(b.peer===a.id||!(await tx.query('SELECT FROM "user" WHERE id=$1',[b.peer])).rowCount) fail(404);
    if(b.block){await tx.query("INSERT INTO community_blocks VALUES($1,$2) ON CONFLICT DO NOTHING",[a.id,b.peer]);await tx.query("UPDATE peer_requests SET accepted=false,sender=$2,recipient=$1 WHERE (sender,recipient) IN (($1,$2),($2,$1))",[a.id,b.peer]);}
    else await tx.query("DELETE FROM community_blocks WHERE actor=$1 AND peer=$2",[a.id,b.peer]);
    return {blocked:b.block};
  }));
  app.get<{Querystring:{history?:boolean}}>(staff+"/doubts",{schema:{querystring:obj({history:{type:"boolean"}},[])}},req=>session(req,async(tx,a)=>({doubts:(await tx.query(`SELECT p.*,s.subject,s.course,s.lesson,
    (SELECT jsonb_agg(jsonb_build_object('id',r.id,'author',r.author,'body',r.body,'verifiedBy',r.verified_by) ORDER BY r.created)
     FROM community_posts r WHERE r.parent=p.id AND NOT r.removed) AS replies FROM community_posts p JOIN shared_spaces s ON s.id=p.space
    JOIN doubt_staff d ON d.subject=s.subject WHERE d.user_id=$1 AND p.parent IS NULL AND NOT p.removed
    AND ($2 OR NOT EXISTS(SELECT FROM community_posts r WHERE r.parent=p.id AND r.verified_by IS NOT NULL AND NOT r.removed)) ORDER BY p.created LIMIT 100`,[a.id,req.query.history??false])).rows})));
  app.post<Path & {Body:{id:string;text:string}}>(staff+"/doubts/:id/reply",{schema:{params,body:obj({id:uuid,text:label(2000)})}},req=>session(req,async(tx,a)=>
    (await tx.query(`INSERT INTO community_posts(id,space,parent,author,body,verified_by)
      SELECT $3,p.space,p.id,$2,$4,$2 FROM community_posts p JOIN shared_spaces s ON s.id=p.space JOIN doubt_staff d ON d.subject=s.subject
      WHERE d.user_id=$2 AND p.id=$1 AND p.parent IS NULL AND NOT p.removed RETURNING id`,[req.params.id,a.id,req.body.id,req.body.text])).rows[0]??fail(404)));
  app.put<Path>(staff+"/answers/:id/verify",{schema:{params}},req=>session(req,async(tx,a)=>
    (await tx.query(`UPDATE community_posts p SET verified_by=$2 FROM shared_spaces s,doubt_staff d WHERE p.id=$1 AND p.space=s.id
      AND p.parent IS NOT NULL AND NOT p.removed AND d.subject=s.subject AND d.user_id=$2 RETURNING p.id`,[req.params.id,a.id])).rows[0]??fail(404)));
  registerModeration(app,session,getChannel,peer);
  registerLibrary(app,session,accessible);
}

async function canReportPost(tx:PoolClient,user:string,id:string,channel:Access,dm:Access) {
  const p=(await tx.query("SELECT space,dm,author,instance FROM community_posts WHERE id=$1",[id])).rows[0]??fail(404);
  if(p.instance) {
    if(!(await tx.query("SELECT FROM occupied_desks WHERE actor=$1 AND space=$2 AND instance=$3",[user,p.space,p.instance])).rowCount) fail(404);
  } else if(p.space) await channel(tx,user,p.space); else await dm(tx,user,p.dm);
  return p;
}
type Access=(tx:PoolClient,user:string,id:string)=>Promise<unknown>;
function registerModeration(app:FastifyInstance,session:Session,channel:Access,dm:Access) {
  const root="/api/v1/community",staff="/api/v1/staff/community";
  app.post<{Body:{post?:string;peer?:string;reason:string}}>(root+"/reports",{schema:{body:obj({post:uuid,peer:label(200),reason:label(2000)},["reason"])}},req=>session(req,async(tx,a)=>{
    const b=req.body;
    if(!!b.post===!!b.peer) fail(422);
    const p=b.post?await canReportPost(tx,a.id,b.post,channel,dm):null;
    if(b.peer && !(await tx.query(`SELECT FROM occupied_desks m JOIN occupied_desks n USING(space,instance) WHERE m.actor=$1 AND n.actor=$2
      UNION ALL SELECT FROM peer_requests WHERE (sender,recipient) IN (($1,$2),($2,$1))`,[a.id,b.peer])).rowCount) fail(404);
    return (await tx.query("INSERT INTO community_reports(reporter,subject,post,reason) VALUES($1,$2,$3,$4) RETURNING id",[a.id,p?.author??b.peer,b.post,b.reason])).rows[0];
  }));
  app.get(staff+"/reports",req=>session(req,async(tx,a)=>{
    await moderator(tx,a.id);
    return {reports:(await tx.query("SELECT r.*,p.body,p.remote_id,s.stoat_channel,to_jsonb(ac) AS action FROM community_reports r LEFT JOIN community_posts p ON p.id=r.post LEFT JOIN shared_spaces s ON s.id=p.space LEFT JOIN community_actions ac ON ac.report=r.id ORDER BY r.created DESC LIMIT 100")).rows};
  }));
  app.get<Path>(staff+"/reports/:id/evidence",{schema:{params}},req=>session(req,async(tx,a)=>{
    await moderator(tx,a.id);
    const p=(await tx.query("SELECT p.body,p.remote_id,s.stoat_channel FROM community_reports r JOIN community_posts p ON p.id=r.post LEFT JOIN shared_spaces s ON s.id=p.space WHERE r.id=$1",[req.params.id])).rows[0]??fail(404);
    return {body:p.remote_id?(await stoat(p.stoat_channel,p.remote_id)).content:p.body};
  }));
  app.post<Path & {Body:{kind:string;reason:string;hours?:number}}>(staff+"/reports/:id/action",{schema:{params,body:obj({
    kind:{enum:["dismiss","warn","remove","mute","restrict"]},reason:label(2000),hours:{type:"integer",minimum:1,maximum:720}},["kind","reason"])}},req=>session(req,async(tx,a)=>{
    await moderator(tx,a.id);const b=req.body;
    const r=(await tx.query("SELECT * FROM community_reports WHERE id=$1",[req.params.id])).rows[0]??fail(404);
    if(["mute","restrict"].includes(b.kind)!==!!b.hours || (b.kind==="remove"&&!r.post)) fail(422);
    if(b.kind==="remove") await tx.query("UPDATE community_posts SET removed=true WHERE id=$1",[r.post]);
    return (await tx.query("INSERT INTO community_actions(report,actor,kind,reason,expires) VALUES($1,$2,$3,$4,now()+$5*interval '1 hour') RETURNING id",[r.id,a.id,b.kind,b.reason,b.hours])).rows[0];
  }));
  app.get(root+"/actions",req=>session(req,async(tx,a)=>({actions:(await tx.query("SELECT ac.id,ac.kind,ac.reason,ac.expires,ac.appeal,ac.decision,ac.overturned FROM community_actions ac JOIN community_reports r ON r.id=ac.report WHERE r.subject=$1 AND ac.kind<>'dismiss' ORDER BY ac.created DESC",[a.id])).rows})));
  app.put<Path & {Body:{reason:string}}>(root+"/actions/:id/appeal",{schema:{params,body:obj({reason:label(2000)})}},req=>session(req,async(tx,a)=>
    (await tx.query("UPDATE community_actions ac SET appeal=$3 FROM community_reports r WHERE r.id=ac.report AND ac.id=$1 AND r.subject=$2 AND appeal IS NULL RETURNING ac.id",[req.params.id,a.id,req.body.reason])).rows[0]??fail(404)));
  app.put<Path & {Body:{reason:string;overturn:boolean}}>(staff+"/actions/:id/decision",{schema:{params,body:obj({reason:label(2000),overturn:{type:"boolean"}})}},req=>session(req,async(tx,a)=>{
    await moderator(tx,a.id);
    const act=(await tx.query(`UPDATE community_actions SET decision=$2,overturned=$3,reviewer=$4 WHERE id=$1 AND appeal IS NOT NULL
      AND decision IS NULL AND actor<>$4 RETURNING kind,report`,[req.params.id,req.body.reason,req.body.overturn,a.id])).rows[0]??fail(409);
    if(act.kind==="remove" && req.body.overturn) await tx.query(`UPDATE community_posts SET removed=false WHERE id=(SELECT post FROM community_reports WHERE id=$1)
      AND NOT EXISTS(SELECT FROM community_reports r JOIN community_actions ac ON ac.report=r.id WHERE r.post=community_posts.id AND ac.kind='remove' AND NOT ac.overturned)`,[act.report]);
    return {id:req.params.id};
  }));
}
