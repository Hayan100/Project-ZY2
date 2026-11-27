import {createHmac} from "node:crypto";
import type {FastifyInstance} from "fastify";
import type {PoolClient} from "pg";
import {fail,type Academic,type sessionTransaction} from "./authorized.ts";
import {activeCaptain,eventManager} from "./family.ts";
import {quizSchema,validateQuiz,type Quiz} from "./quizzes.ts";

const uuid={type:"string",format:"uuid"};
const label=(maxLength:number)=>({type:"string",pattern:"\\S",maxLength});
const integer=(minimum:number,maximum:number)=>({type:"integer",minimum,maximum});
const object=(properties:Record<string,object>,required=Object.keys(properties))=>({type:"object",properties,required,additionalProperties:false});
const params=object({id:uuid});
type Path={Params:{id:string}};
type Leadership={captain?:string;deputy:string};
type Choice={question:string;option:string};
const leadership=object({captain:label(200),deputy:label(200)},["deputy"]);
const choice={question:uuid,option:uuid};
const revision=integer(0,2147483646);
const enrolled=`EXISTS(SELECT FROM enrollments e WHERE e.user_id=p.player AND e.product_key=b.product_key
  AND e.revoked_at IS NULL AND e.starts_at<=now() AND e.ends_at>now())`;
const eligible=enrolled+` AND (s.family IS NULL OR EXISTS(SELECT FROM family_students m WHERE m.user_id=p.player AND m.family_id=s.family))`;
const members=`FROM live_players p JOIN live_sides s USING(room,side) JOIN live_rooms r ON r.id=p.room JOIN live_papers b ON b.id=r.paper`;
const fresh="interval '30 seconds'";
type Room={question_ids:string[]|null;id:string;event:string|null;quiz:Quiz;started:Date|null;deadline:Date|null;seconds:number;lobby_until:Date;side:number};
async function access(tx:PoolClient,id:string,user:string):Promise<Room> {
  const room=(await tx.query<Room>(`SELECT r.*,b.quiz,b.seconds,p.side ${members} WHERE p.room=$1 AND p.player=$2 AND ${eligible} FOR UPDATE OF r`,[id,user])).rows[0] ?? fail(404);
  if(room.question_ids) {
    const selected=new Set(room.question_ids);
    room.quiz.questions=room.quiz.questions.filter(q=>selected.has(q.id));
  }
  if(room.started && room.event) {
    await tx.query(`UPDATE live_sides s SET controller=deputy,version=version+1 FROM live_players p
      WHERE p.room=s.room AND p.player=s.captain AND s.room=$1 AND s.side=$2 AND controller=captain AND submitted IS NULL
      AND p.seen<=clock_timestamp()-${fresh} AND $3::timestamptz>clock_timestamp()`,[id,room.side,room.deadline]);
  }
  await tx.query("UPDATE live_players SET seen=clock_timestamp() WHERE room=$1 AND player=$2",[id,user]);
  return room;
}
async function createSide(tx:PoolClient,room:string,side:number,family:string|null,players:string[],captain:string,deputy?:string) {
  if(!players.includes(captain) || (deputy!==undefined && (!players.includes(deputy)||deputy===captain))) fail(422);
  await tx.query("INSERT INTO live_sides(room,side,family,captain,deputy,controller) VALUES($1,$2,$3,$4,$5,$4)",[room,side,family,captain,deputy]);
  await tx.query("INSERT INTO live_players(room,side,player) SELECT $1,$2,unnest($3::text[])",[room,side,players]);
}
async function sideState(tx:PoolClient,r:Room) {
  return (await tx.query("SELECT answers,controller,captain,deputy,version,submitted FROM live_sides WHERE room=$1 AND side=$2",[r.id,r.side])).rows[0];
}
async function playable(tx:PoolClient,r:Room) {
  if(!(await tx.query("SELECT FROM live_sides WHERE room=$1 AND side=$2 AND submitted IS NULL AND clock_timestamp()<$3",[r.id,r.side,r.deadline])).rowCount) fail(409);
}
async function boards(tx:PoolClient,r:Room) {
  return (await tx.query(`SELECT player,votes,board_question AS question,board_phase AS phase,
    board_version AS version,board_at AS "changedAt" FROM live_players WHERE room=$1 AND side=$2 ORDER BY player`,[r.id,r.side])).rows;
}
function validateChoice(r:Room,b:Choice) {
  if(!r.quiz.questions.find(q=>q.id===b.question)?.options.some(o=>o.id===b.option)) fail(422);
}
export function registerLive(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>,academic:Academic) {
  const base="/api/v1/live",room=base+"/rooms/:id";
  app.post<{Body:{id:string;mode:string;productKey:string;seconds:number;quiz:Quiz}}>("/api/v1/staff/live/papers",{schema:{body:object({
    id:uuid,mode:{enum:["duel","battle"]},productKey:label(120),seconds:integer(30,7200),quiz:quizSchema})}},req=>academic(req,async(tx,user)=>{
    const b=req.body;
    validateQuiz(b.quiz);
    if(!b.quiz.questions.length) fail(422);
    await tx.query("INSERT INTO live_papers VALUES($1,$2,$3,$4,$5,$6)",[b.id,b.productKey,b.mode,b.quiz,b.seconds,user]);
    return {id:b.id};
  }));
  app.get(base+"/duel-papers",req=>session(req,async(tx,a)=>({papers:(await tx.query(`SELECT b.id,b.quiz->>'title' AS title,b.seconds,
    jsonb_array_length(b.quiz->'questions') AS questions FROM live_papers b CROSS JOIN (SELECT $1::text AS player) p
    WHERE mode='duel' AND ${enrolled} ORDER BY title,b.id`,[a.id])).rows})));
  app.post<{Body:{paper:string;friend:string;questionCount?:number}}>(base+"/duels",{schema:{body:object({paper:uuid,friend:label(200),questionCount:integer(1,200)},["paper","friend"])}},req=>session(req,async(tx,a)=>{
    const b=req.body;
    if(a.id===b.friend) fail(422);
    if((await tx.query(`SELECT FROM live_papers b CROSS JOIN unnest($2::text[]) p(player) WHERE b.id=$1 AND mode='duel' AND ${enrolled}`,[b.paper,[a.id,b.friend]])).rowCount!==2) fail(404);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,27))",[JSON.stringify([a.id,b.friend].sort())]);
    if((await tx.query(`SELECT FROM live_rooms r JOIN live_players p ON p.room=r.id WHERE r.creator=$1 AND p.player=$2
      AND r.event IS NULL AND r.started IS NULL AND r.lobby_until>now()`,[a.id,b.friend])).rowCount) fail(409);
    const selected=(await tx.query(`SELECT q->>'id' AS id FROM live_papers CROSS JOIN jsonb_array_elements(quiz->'questions') q
      WHERE id=$1 ORDER BY random() LIMIT $2`,[b.paper,b.questionCount??200])).rows.map(q=>q.id);
    if(b.questionCount && selected.length<b.questionCount) fail(422);
    const {id}=(await tx.query("INSERT INTO live_rooms(paper,creator,lobby_until,question_ids) VALUES($1,$2,now()+interval '10 minutes',$3) RETURNING id",[b.paper,a.id,selected])).rows[0];
    await createSide(tx,id,1,null,[a.id],a.id);
    await createSide(tx,id,2,null,[b.friend],b.friend);
    return {id};
  }));
  app.post<Path & {Body:{paper:string;home:Leadership;away:Leadership}}>("/api/v1/staff/live/battles/:id",{schema:{params,body:object({
    paper:uuid,home:leadership,away:leadership})}},req=>session(req,async(tx,a)=>{
    const event=req.params.id,b=req.body;
    await eventManager(tx,event,a.id);
    const e=(await tx.query(`SELECT e.* FROM family_events e JOIN families f ON f.id=e.home JOIN live_papers p ON p.product_key=f.product_key
      WHERE e.id=$1 AND p.id=$2 AND p.mode='battle' AND e.recorded_by IS NULL AND now() BETWEEN e.opens_at AND e.closes_at FOR UPDATE OF e`,[event,b.paper])).rows[0] ?? fail(409);
    const {id}=(await tx.query("INSERT INTO live_rooms(paper,event,creator,lobby_until) VALUES($1,$2,$3,$4) RETURNING id",[b.paper,event,a.id,e.closes_at])).rows[0];
    for(const [side,family,leaders] of [[1,e.home,b.home],[2,e.away,b.away]] as const) {
      const players=(await tx.query(`SELECT DISTINCT p.user_id FROM family_entries p JOIN family_students m USING(family_id,user_id)
        WHERE p.event_id=$1 AND p.family_id=$2`,[event,family])).rows.map(p=>p.user_id as string);
      const captain=leaders.captain ?? (await tx.query("SELECT c.student_id "+activeCaptain,[family])).rows[0]?.student_id;
      await createSide(tx,id,side,family,players,captain,leaders.deputy);
    }
    return {id};
  }));
  app.get(base+"/rooms",req=>session(req,async(tx,a)=>({rooms:(await tx.query(`SELECT r.id,r.event,b.mode,b.quiz->>'title' AS title,
    r.started,r.deadline,r.lobby_until ${members} WHERE p.player=$1 AND ${eligible} ORDER BY r.lobby_until DESC,r.id`,[a.id])).rows})));
  app.put<Path & {Body:{ready:boolean}}>(room+"/ready",{schema:{params,body:object({ready:{type:"boolean"}})}},req=>session(req,async(tx,a)=>{
    const r=await access(tx,req.params.id,a.id);
    if(r.started || !(await tx.query("SELECT WHERE clock_timestamp()<$1",[r.lobby_until])).rowCount) fail(409);
    await tx.query("UPDATE live_players SET ready=$3 WHERE room=$1 AND player=$2",[r.id,a.id,req.body.ready]);
    const start=await tx.query(`UPDATE live_rooms SET started=t,deadline=CASE WHEN event IS NULL THEN t+$2*interval '1 second'
      ELSE least(lobby_until,t+$2*interval '1 second') END FROM (SELECT clock_timestamp() t) clock
      WHERE id=$1 AND t<lobby_until AND NOT EXISTS(SELECT ${members} WHERE p.room=$1 AND
      (NOT ready OR seen IS NULL OR seen<t-${fresh} OR NOT (${eligible}))) RETURNING started,deadline`,[r.id,r.seconds]);
    return start.rows[0] ?? {started:null};
  }));
  app.get<Path>(room,{schema:{params}},req=>session(req,async(tx,a)=>{
    const r=await access(tx,req.params.id,a.id);
    const roster=(await tx.query(`SELECT p.player,u.name,u.image AS "avatarUrl",p.side,s.family,p.ready,s.captain,s.deputy FROM live_players p
      JOIN "user" u ON u.id=p.player JOIN live_sides s USING(room,side) WHERE p.room=$1 ORDER BY p.side,p.player`,[r.id])).rows;
    const ranked=r.event && (await tx.query("SELECT ranked_by IS NOT NULL AS ranked FROM family_events WHERE id=$1",[r.event])).rows[0].ranked;
    const info={id:r.id,ranked:!!ranked,title:r.quiz.title,seconds:r.seconds,lobbyUntil:r.lobby_until,roster,
      counts:[1,2].map(side=>roster.filter(p=>p.side===side).length),sharesScores:true,questionCount:r.quiz.questions.length,started:r.started,deadline:r.deadline};
    if(!r.started) return info;
    const scores=(await tx.query(`SELECT side,score,extract(epoch FROM elapsed)*1000 AS "elapsedMs",
      dense_rank() OVER(ORDER BY score DESC,elapsed)::int AS rank FROM live_scores WHERE room=$1 ORDER BY side`,[r.id])).rows;
    const own=await sideState(tx,r);
    const votes=r.event?await boards(tx,r):[];
    return {...info,own,votes,unanswered:r.quiz.questions.length-Object.keys(own.answers).length,scores,
      questions:scores.length?r.quiz.questions:r.quiz.questions.map(({id,stem,options})=>({id,stem,options}))};
  }));
  app.get<Path>(room+"/boards",{schema:{params}},req=>session(req,async(tx,a)=>{
    const r=await access(tx,req.params.id,a.id);
    if(!r.event || !r.started) fail(404);
    return {boards:await boards(tx,r),deadline:r.deadline,submitted:(await sideState(tx,r)).submitted};
  }));
  app.put<Path & {Body:{question:string;phase:string;version:number}}>(room+"/board",{schema:{params,body:object({
    question:uuid,phase:{enum:["thinking","selecting"]},version:revision})}},req=>session(req,async(tx,a)=>{
    const r=await access(tx,req.params.id,a.id),b=req.body;
    if(!r.event) fail(409);
    if(!r.quiz.questions.some(q=>q.id===b.question)) fail(422);
    await playable(tx,r);
    return (await tx.query(`UPDATE live_players SET board_question=$3,board_phase=$4,board_version=board_version+1,board_at=clock_timestamp()
      WHERE room=$1 AND player=$2 AND board_version=$5 AND clock_timestamp()<$6 RETURNING board_version AS version`,
      [r.id,a.id,b.question,b.phase,b.version,r.deadline])).rows[0] ?? fail(409);
  }));
  app.put<Path & {Body:Choice & {version:number}}>(room+"/vote",{schema:{params,body:object({...choice,version:revision})}},req=>session(req,async(tx,a)=>{
    const r=await access(tx,req.params.id,a.id);
    if(!r.event) fail(409);
    validateChoice(r,req.body);
    await playable(tx,r);
    return (await tx.query(`UPDATE live_players SET votes=votes||jsonb_build_object($3::text,$4::text),board_question=($3::text)::uuid,
      board_phase='raised',board_version=board_version+1,board_at=clock_timestamp() WHERE room=$1 AND player=$2
      AND board_version=$5 AND clock_timestamp()<$6 RETURNING board_version AS version`,
      [r.id,a.id,req.body.question,req.body.option,req.body.version,r.deadline])).rows[0] ?? fail(409);
  }));
  app.put<Path & {Body:Choice & {version:number}}>(room+"/answer",{schema:{params,body:object({...choice,version:revision})}},req=>session(req,async(tx,a)=>{
    const r=await access(tx,req.params.id,a.id),b=req.body;
    validateChoice(r,b);
    return (await tx.query(`UPDATE live_sides SET answers=answers||jsonb_build_object($4::text,$5::text),version=version+1
      WHERE room=$1 AND side=$2 AND controller=$3 AND submitted IS NULL AND version=$6 AND clock_timestamp()<$7 RETURNING version`,
      [r.id,r.side,a.id,b.question,b.option,b.version,r.deadline])).rows[0] ?? fail(409);
  }));
  app.post<Path & {Body:{version:number;unanswered:number}}>(room+"/submit",{schema:{params,body:object({version:revision,unanswered:integer(0,200)})}},req=>session(req,async(tx,a)=>{
    const r=await access(tx,req.params.id,a.id),own=await sideState(tx,r);
    if(req.body.unanswered!==r.quiz.questions.length-Object.keys(own.answers).length) fail(409);
    return (await tx.query(`UPDATE live_sides SET submitted=t FROM (SELECT clock_timestamp() t) clock WHERE room=$1 AND side=$2
      AND controller=$3 AND version=$4 AND submitted IS NULL AND t<$5 RETURNING submitted`,[r.id,r.side,a.id,req.body.version,r.deadline])).rows[0] ?? fail(409);
  }));
  app.post<Path>(room+"/handback",{schema:{params}},req=>session(req,async(tx,a)=>{
    const r=await access(tx,req.params.id,a.id);
    return (await tx.query(`UPDATE live_sides s SET controller=captain,version=version+1 FROM live_players p WHERE s.room=$1 AND s.side=$2
      AND controller=$3 AND deputy=$3 AND submitted IS NULL AND p.room=s.room AND p.player=captain AND p.seen>clock_timestamp()-${fresh}
      AND clock_timestamp()<$4 RETURNING controller,version`,[r.id,r.side,a.id,r.deadline])).rows[0] ?? fail(409);
  }));
  app.get<Path>(room+"/voice",{schema:{params}},(req,reply)=>session(req,async(tx,a)=>{
    const r=await access(tx,req.params.id,a.id);
    if(!r.event) fail(404);
    await playable(tx,r);
    reply.header("Cache-Control","no-store");
    const url=process.env.BATTLE_TURN_URL,secret=process.env.BATTLE_TURN_SECRET;
    if(!url && !secret) return {iceServers:[]};
    if(!url || !secret || !/^turns?:/i.test(url)) fail(503);
    const username=Math.floor(r.deadline!.getTime()/1000)+":"+r.id+":"+a.id;
    const credential=createHmac("sha1",secret).update(username).digest("base64");
    return {iceServers:[{urls:url,username,credential}]};
  }));
  app.post<Path & {Body:{kind:string;recipient?:string;body:string}}>(room+"/messages",{schema:{params,body:object({
    kind:{enum:["text","offer","answer","ice"]},recipient:label(200),body:label(16384)},["kind","body"])}},req=>session(req,async(tx,a)=>{
    const r=await access(tx,req.params.id,a.id),b=req.body;
    if(!r.event || (b.kind==="text")!==!b.recipient) fail(422);
    await playable(tx,r);
    if(b.recipient && !(await tx.query(`SELECT ${members} WHERE p.room=$1 AND p.side=$2 AND p.player=$3 AND ${eligible}`,[r.id,r.side,b.recipient])).rowCount) fail(404);
    return (await tx.query("INSERT INTO live_messages(room,side,sender,recipient,kind,body) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
      [r.id,r.side,a.id,b.recipient,b.kind,b.body])).rows[0];
  }));
  app.get<Path & {Querystring:{after?:number}}>(room+"/messages",{schema:{params,querystring:object({after:integer(0,Number.MAX_SAFE_INTEGER)},[])}},req=>session(req,async(tx,a)=>{
    const r=await access(tx,req.params.id,a.id);
    if(!r.event) fail(404);
    await playable(tx,r);
    return {messages:(await tx.query(`SELECT id,sender,kind,body FROM live_messages WHERE room=$1 AND side=$2 AND
      (recipient IS NULL OR recipient=$3) AND id>$4 ORDER BY id LIMIT 100`,[r.id,r.side,a.id,req.query.after??0])).rows};
  }));
}
