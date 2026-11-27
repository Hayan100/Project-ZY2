import type {FastifyInstance} from "fastify";
import type {PoolClient} from "pg";
import {createHmac} from "node:crypto";
import {fail} from "./authorized.ts";
import {libraryBooks} from "./ebooks.ts";
import {loadCourse} from "./learning.ts";
import {allowed,blocked,label,moderator,obj,params,uuid,type Path,type Session} from "./community.ts";

const sameFamily="SELECT FROM family_members m JOIN family_members n USING(family_id) WHERE m.user_id=$1 AND n.user_id=$2";
const roomList=`SELECT s.id,s.name,s.kind,s.capacity,s.instances,s.invitation FROM shared_spaces s JOIN space_access a USING(id)
  WHERE a.actor=$1 AND s.capacity IS NOT NULL`;
async function desk(tx:PoolClient,user:string,id:string) {
  await allowed(tx,user);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,51))",[user]);
  const d=(await tx.query("SELECT d.*,s.kind FROM occupied_desks d JOIN shared_spaces s ON s.id=d.space WHERE actor=$1 AND session_id=$2",[user,id])).rows[0]??fail(404);
  await tx.query("UPDATE library_desks SET seen=clock_timestamp() WHERE actor=$1 AND session_id=$2",[user,id]);
  return d;
}
async function presence(tx:PoolClient,user:string,space:string,instance:number) {
  return (await tx.query(`SELECT d.actor,u.name,u.image AS avatar,d.voice FROM occupied_desks d JOIN "user" u ON u.id=d.actor
    WHERE d.space=$1 AND d.instance=$2 AND NOT EXISTS(SELECT FROM community_blocks WHERE (actor,peer) IN (($3,d.actor),(d.actor,$3))) ORDER BY d.actor`,[space,instance,user])).rows;
}
export function registerLibrary(app:FastifyInstance,session:Session,accessible:string) {
  const root="/api/v1/library",room=root+"/rooms/:id",seat=root+"/desks/:id";
  app.get(root,req=>session(req,async(tx,a)=>{
    await allowed(tx,a.id);
    return {rooms:(await tx.query(roomList+" ORDER BY s.name,s.id",[a.id])).rows,desk:(await tx.query("SELECT session_id,space,instance FROM occupied_desks WHERE actor=$1",[a.id])).rows[0]??null,
      familyStudying:(await tx.query(`SELECT DISTINCT d.actor,d.space,d.instance FROM family_members m JOIN family_members n USING(family_id)
        JOIN occupied_desks d ON d.actor=n.user_id JOIN space_access x ON x.id=d.space AND x.actor=m.user_id WHERE m.user_id=$1 AND d.actor<>$1
        AND NOT EXISTS(SELECT FROM community_blocks WHERE (actor,peer) IN (($1,d.actor),(d.actor,$1)))`,[a.id])).rows,
      invitations:(await tx.query("SELECT i.space,i.instance,i.sender FROM library_invites i JOIN space_access a ON a.id=i.space AND a.actor=i.actor WHERE i.actor=$1 AND i.expires>now() AND NOT EXISTS(SELECT FROM community_blocks WHERE (actor,peer) IN ((i.actor,i.sender),(i.sender,i.actor)))",[a.id])).rows};
  }));
  app.put<Path & {Body:{capacity:number}}>("/api/v1/staff/library/rooms/:id/capacity",{schema:{params,body:obj({capacity:{type:"integer",minimum:1,maximum:24}})}},req=>session(req,async(tx,a)=>{
    await moderator(tx,a.id);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,52))",[req.params.id]);
    return (await tx.query("UPDATE shared_spaces SET capacity=$2 WHERE id=$1 AND capacity IS NOT NULL RETURNING capacity",[req.params.id,req.body.capacity])).rows[0]??fail(404);
  }));
  app.post<Path & {Body:{joinPeer?:string}}>(room+"/join",{schema:{params,body:obj({joinPeer:label(200)},[])}},req=>session(req,async(tx,a)=>{
    await allowed(tx,a.id);
    const id=req.params.id,target=req.body.joinPeer;
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,51))",[a.id]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,52))",[id]);
    const r=(await tx.query(roomList+" AND s.id=$2",[a.id,id])).rows[0];
    if(!r) return {status:"unavailable"};
    const options=(await tx.query(`SELECT i AS instance FROM generate_series(1,$2::int) i
      LEFT JOIN occupied_desks d ON d.space=$1 AND d.instance=i GROUP BY i HAVING count(d.actor)<$3 ORDER BY count(d.actor) DESC,i`,[id,r.instances,r.capacity])).rows;
    async function full() {
      const alternative=options.length?{space:id,instance:options[0].instance}:(await tx.query(`SELECT s.id AS space,n AS instance FROM shared_spaces s JOIN space_access x USING(id)
        CROSS JOIN generate_series(1,s.instances) n WHERE x.actor=$1 AND s.id<>$2 AND s.kind=$3 AND s.capacity>
        (SELECT count(*) FROM occupied_desks d WHERE d.space=s.id AND d.instance=n) ORDER BY s.name,s.id,n LIMIT 1`,[a.id,id,r.kind])).rows[0]??null;
      return {status:"full",alternativeAvailable:!!alternative,alternative};
    }
    let instance=options[0]?.instance;
    const current=(await tx.query("SELECT * FROM occupied_desks WHERE actor=$1 AND space=$2",[a.id,id])).rows[0];
    if(target) {
      const family=!!(await tx.query(sameFamily,[a.id,target])).rowCount;
      const invitation=(await tx.query("SELECT instance FROM library_invites WHERE actor=$1 AND sender=$2 AND space=$3 AND expires>now()",[a.id,target,id])).rows[0];
      if((!family&&!invitation)||await blocked(tx,a.id,target)) return {status:"unavailable"};
      const peer=(await tx.query("SELECT instance FROM occupied_desks WHERE actor=$1 AND space=$2",[target,id])).rows[0];
      if(!peer||(!family&&invitation.instance!==peer.instance)) return {status:"unavailable"};
      instance=peer.instance;
      if(current?.instance!==instance && (await tx.query("SELECT count(*)::int AS n FROM occupied_desks WHERE space=$1 AND instance=$2",[id,instance])).rows[0].n>=(family?24:r.capacity))
        return full();
    } else if(current) instance=current.instance;
    if(!instance) return full();
    if(current?.instance===instance){
      await tx.query("UPDATE library_desks SET seen=clock_timestamp() WHERE actor=$1",[a.id]);
      return {status:"joined",id:current.session_id,instance};
    }
    const d=(await tx.query(`INSERT INTO library_desks(actor,space,instance) VALUES($1,$2,$3) ON CONFLICT(actor) DO UPDATE SET
      session_id=gen_random_uuid(),space=excluded.space,instance=excluded.instance,seen=clock_timestamp(),voice=false,ebook=NULL,course=NULL,lesson=NULL,focus_start=NULL,focus_end=NULL RETURNING session_id`,[a.id,id,instance])).rows[0];
    return {status:"joined",id:d.session_id,instance};
  }));
  app.post<Path & {Body:{peer:string;instance?:number}}>(room+"/invite",{schema:{params,body:obj({peer:label(200),instance:{type:"integer",minimum:1,maximum:16}},["peer"])}},req=>session(req,async(tx,a)=>{
    const id=req.params.id,b=req.body;await allowed(tx,a.id,true);
    if(b.peer===a.id||await blocked(tx,a.id,b.peer)) fail(404);
    const own=(await tx.query("SELECT instance FROM occupied_desks WHERE actor=$1 AND space=$2",[a.id,id])).rows[0];
    if(!own) await moderator(tx,a.id);
    else if(!(await tx.query(sameFamily+" UNION ALL SELECT FROM peer_requests WHERE accepted AND (sender,recipient) IN (($1,$2),($2,$1))",[a.id,b.peer])).rowCount) fail(404);
    const instance=own?.instance??b.instance??1;
    if(!(await tx.query('SELECT FROM shared_spaces,"user" u WHERE shared_spaces.id=$1 AND instances>=$2 AND u.id=$3',[id,instance,b.peer])).rowCount) fail(404);
    await tx.query(`INSERT INTO library_invites VALUES($1,$2,$3,$4,now()+interval '1 day') ON CONFLICT(space,actor) DO UPDATE SET instance=excluded.instance,sender=excluded.sender,expires=excluded.expires`,[id,instance,b.peer,a.id]);
    return {invited:true};
  }));
  app.get<Path>(seat,{schema:{params}},req=>session(req,async(tx,a)=>{
    const d=await desk(tx,a.id,req.params.id);
    let resource=null;
    if(d.ebook && (await libraryBooks(tx,a.id)).some(b=>b.id===d.ebook)) resource={ebook:d.ebook};
    if(d.course) {
      try {const l=(await loadCourse(tx,accessible,a.id,d.course)).available(d.lesson);resource={course:d.course,lesson:l.id};}
      catch(err){if(![403,404].includes((err as {statusCode:number}).statusCode)) throw err;}
    }
    return {id:d.session_id,space:d.space,instance:d.instance,kind:d.kind,focusStart:d.focus_start,focusEnd:d.focus_end,resource,
      occupants:await presence(tx,a.id,d.space,d.instance)};
  }));
  app.put<Path & {Body:{minutes:number}}>(seat+"/focus",{schema:{params,body:obj({minutes:{type:"integer",minimum:0,maximum:180}})}},req=>session(req,async(tx,a)=>{
    const d=await desk(tx,a.id,req.params.id);
    return (await tx.query(`UPDATE library_desks SET focus_start=CASE WHEN $2::int>0 THEN coalesce(CASE WHEN focus_end>now() THEN focus_start END,now()) END,
      focus_end=CASE WHEN $2>0 THEN CASE WHEN focus_end>now() THEN focus_end ELSE now()+$2*interval '1 minute' END END WHERE session_id=$1 RETURNING focus_start,focus_end`,[d.session_id,req.body.minutes])).rows[0];
  }));
  app.put<Path & {Body:{course?:string;lesson?:string;ebook?:string}}>(seat+"/resource",{schema:{params,body:obj({course:uuid,lesson:uuid,ebook:uuid},[])}},req=>session(req,async(tx,a)=>{
    const d=await desk(tx,a.id,req.params.id),b=req.body;
    if(b.ebook) {
      if(b.course||b.lesson) fail(422);
      if(!(await libraryBooks(tx,a.id)).some(book=>book.id===b.ebook)) fail(404);
    } else {
      if(!b.course||!b.lesson) fail(422);
      (await loadCourse(tx,accessible,a.id,b.course)).available(b.lesson);
    }
    await tx.query("UPDATE library_desks SET course=$2,lesson=$3,ebook=$4 WHERE session_id=$1",[d.session_id,b.course,b.lesson,b.ebook]);
    return b;
  }));
  app.delete<Path>(seat,{schema:{params}},req=>session(req,async(tx,a)=>{
    await tx.query("DELETE FROM library_desks WHERE actor=$1 AND session_id=$2",[a.id,req.params.id]);return {left:true};
  }));
  app.put<Path & {Body:{enabled:boolean}}>(seat+"/voice",{schema:{params,body:obj({enabled:{type:"boolean"}})}},(req,reply)=>session(req,async(tx,a)=>{
    const d=await desk(tx,a.id,req.params.id),on=req.body.enabled;
    if(d.kind!=="social") fail(403);
    if(on) await allowed(tx,a.id,true);
    await tx.query("UPDATE library_desks SET voice=$2 WHERE session_id=$1",[d.session_id,on]);
    if(!on) await tx.query("DELETE FROM library_signals WHERE sender=$1 OR recipient=$1",[d.session_id]);
    reply.header("Cache-Control","no-store");
    const urls=process.env.BATTLE_TURN_URL,secret=process.env.BATTLE_TURN_SECRET;
    if(!on || (!urls&&!secret)) return {enabled:on,iceServers:[]};
    if(!urls || !secret || !/^turns?:/i.test(urls)) fail(503);
    const username=Math.floor(Date.now()/1000+300)+":"+d.session_id;
    return {enabled:on,iceServers:[{urls,username,credential:createHmac("sha1",secret).update(username).digest("base64")}]};
  }));
  app.post<Path & {Body:{peer:string;kind:string;body:string}}>(seat+"/signals",{schema:{params,body:obj({peer:label(200),kind:{enum:["offer","answer","ice"]},body:label(16384)})}},req=>session(req,async(tx,a)=>{
    const d=await desk(tx,a.id,req.params.id),b=req.body;await allowed(tx,a.id,true);
    if(!d.voice||d.kind!=="social"||await blocked(tx,a.id,b.peer)) fail(403);
    const peer=(await tx.query("SELECT session_id FROM occupied_desks WHERE space=$1 AND instance=$2 AND actor=$3 AND voice",[d.space,d.instance,b.peer])).rows[0]??fail(404);
    await tx.query("DELETE FROM library_signals WHERE created<now()-interval '2 minutes'");
    return (await tx.query("INSERT INTO library_signals(sender,recipient,kind,body) VALUES($1,$2,$3,$4) RETURNING id",[d.session_id,peer.session_id,b.kind,b.body])).rows[0];
  }));
  app.get<Path & {Querystring:{after?:number}}>(seat+"/signals",{schema:{params,querystring:obj({after:{type:"integer",minimum:0,maximum:Number.MAX_SAFE_INTEGER}},[])}},req=>session(req,async(tx,a)=>{
    const d=await desk(tx,a.id,req.params.id);
    if(!d.voice||d.kind!=="social") fail(403);
    await allowed(tx,a.id,true);
    return {signals:(await tx.query(`SELECT s.id,p.actor,s.kind,s.body FROM library_signals s JOIN occupied_desks p ON p.session_id=s.sender WHERE s.recipient=$1
      AND p.space=$2 AND p.instance=$3 AND p.voice AND s.id>$4 AND s.created>now()-interval '2 minutes'
      AND NOT EXISTS(SELECT FROM community_blocks WHERE (actor,peer) IN (($5,p.actor),(p.actor,$5))) ORDER BY id LIMIT 100`,[d.session_id,d.space,d.instance,req.query.after??0,a.id])).rows};
  }));
  app.post<Path & {Body:{text:string}}>(seat+"/chat",{schema:{params,body:obj({text:label(2000)})}},req=>session(req,async(tx,a)=>{
    const d=await desk(tx,a.id,req.params.id);await allowed(tx,a.id,true);
    if(d.kind!=="social") fail(403);
    return (await tx.query("INSERT INTO community_posts(id,space,instance,author,body) VALUES(gen_random_uuid(),$1,$2,$3,$4) RETURNING id",[d.space,d.instance,a.id,req.body.text])).rows[0];
  }));
  app.get<Path>(seat+"/chat",{schema:{params}},req=>session(req,async(tx,a)=>{
    const d=await desk(tx,a.id,req.params.id);
    if(d.kind!=="social") fail(403);
    return {messages:(await tx.query(`SELECT id,author,body,created FROM community_posts p WHERE space=$1 AND instance=$2 AND NOT removed
      AND NOT EXISTS(SELECT FROM community_blocks WHERE (actor,peer) IN (($3,author),(author,$3))) ORDER BY created DESC,id DESC LIMIT 50`,[d.space,d.instance,a.id])).rows};
  }));
}
