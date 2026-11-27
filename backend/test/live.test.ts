import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {buildApi} from "../src/api.ts";
import {registerRoutes} from "../src/router.ts";

test("live duels and family battles seal keys, fence answer control and score on the server",{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const connectionString=process.env.TEST_DATABASE_URL,db=new Pool({connectionString}),runtime=new Pool({connectionString,options:"-c role=zy2_api"});
  const app=buildApi(async()=>[]);
  t.after(async()=>{await app.close();await runtime.end();await db.end();});
  const [staff,g1,g2,a,b,c,d,e]=Array.from({length:8},()=>randomUUID());
  for(const id of [staff,g1,g2,a,b,c,d,e]) {
    await db.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',[id,id+"@example.org"]);
    await db.query(`INSERT INTO session(id,"userId",token,"createdAt","updatedAt","expiresAt") VALUES($1,$1,$1,now(),now(),now()+interval '2 hours')`,[id]);
  }
  for(const id of [staff,g1,g2]) await db.query("INSERT INTO staff_members VALUES($1)",[id]);
  await db.query("INSERT INTO academic_staff VALUES($1)",[staff]);
  const product=randomUUID(),home=randomUUID(),away=randomUUID(),event=randomUUID();
  await db.query("INSERT INTO welcome_products(product_key,route) VALUES($1,'mentored')",[product]);
  for(const [i,id] of [g1,g2].entries()) {
    await db.query("INSERT INTO ghazis VALUES($1,$2,6,true,'Teaching','Weekdays',60)",[id,1000+i]);
    await db.query("INSERT INTO families(id,name,mentor_id,product_key,created_by) VALUES($1,$2,$3,$4,$5)",[i?away:home,"Family "+id,id,product,staff]);
  }
  await db.query(`INSERT INTO family_events(id,home,away,title,opens_at,closes_at,created_by,ranked_by,ranked_at)
    VALUES($1,$2,$3,'Skills',now()-interval '1 minute',now()+interval '1 hour',$4,$4,now())`,[event,home,away,staff]);
  for(const id of [a,b,c,d,e]) {
    const en=randomUUID(),first=id===a||id===b;
    await db.query("INSERT INTO enrollments(id,user_id,product_key,starts_at,ends_at) VALUES($1,$2,$3,now()-interval '1 day',now()+interval '1 week')",[en,id,product]);
    await db.query("INSERT INTO ghazi_assignments(enrollment_id,version,mentor_id,assigned_by) VALUES($1,1,$2,$3)",[en,first?g1:g2,staff]);
    await db.query("INSERT INTO family_entries(event_id,user_id,family_id) VALUES($1,$2,$3)",[event,id,first?home:away]);
  }
  registerRoutes(app,runtime,async cookie=>cookie?{user:{id:cookie,emailVerified:true},session:{id:cookie}}:null,"http://localhost");
  async function call(method:"GET"|"PUT"|"POST",path:string,user:string,payload?:object,status=200) {
    const res=await app.inject({method,url:"/api/v1/"+path,headers:{cookie:user},payload});
    assert.equal(res.statusCode,status,path+" "+res.body);
    return res.json();
  }
  const question=randomUUID(),option=randomUUID(),duel=randomUUID(),battle=randomUUID(),pair={question,option};
  for(const [mode,id] of [["duel",duel],["battle",battle]]) {
    await call("POST","staff/live/papers",staff,{id,mode,productKey:product,seconds:60,quiz:{title:"Test",questions:[{
      id:question,stem:"Select one",options:[{id:option,text:"One"},{id:randomUUID(),text:"Two"}],correctOptionId:option,explanation:"Released explanation"}]}});
  }
  const duelId=(await call("POST","live/duels",a,{paper:duel,friend:b})).id;
  assert.equal((await call("GET","live/rooms",b)).rooms[0].id,duelId);
  const duelRoom="live/rooms/"+duelId;
  await call("GET",duelRoom,c,undefined,404);
  assert.equal((await call("PUT",duelRoom+"/ready",a,{ready:true})).started,null);
  assert.ok((await call("PUT",duelRoom+"/ready",b,{ready:true})).deadline);
  await call("PUT",duelRoom+"/answer",a,{...pair,version:0});
  await call("POST",duelRoom+"/submit",a,{version:1,unanswered:0});
  const playing=await call("GET",duelRoom,b);
  assert.deepEqual(playing.own.answers,{});
  assert.equal(playing.questions[0].correctOptionId,undefined);
  await call("POST",duelRoom+"/submit",b,{version:0,unanswered:1});
  const result=await call("GET",duelRoom,b);
  assert.equal(result.questions[0].explanation,"Released explanation");
  assert.deepEqual(result.scores.map((s:{rank:number})=>s.rank),[1,2]);
  assert.equal((await call("GET","me/progress",a)).quiz.correct,1);
  const id=(await call("POST","staff/live/battles/"+event,staff,{paper:battle,home:{captain:a,deputy:b},away:{captain:c,deputy:d}})).id;
  const room="live/rooms/"+id;
  assert.deepEqual((await call("GET",room,b)).counts,[2,3]);
  for(const player of [a,b,c,d,e]) await call("PUT",room+"/ready",player,{ready:true});
  assert.ok(Array.isArray((await call("GET",room+"/voice",a)).iceServers));
  await call("GET",room+"/voice",staff,undefined,404);
  await call("PUT",room+"/board",b,{question,phase:"thinking",version:0});
  await call("PUT",room+"/board",b,{question,phase:"selecting",version:1});
  const choosing=(await call("GET",room+"/boards",a)).boards.find((v:{player:string})=>v.player===b);
  assert.equal(choosing.phase,"selecting");
  assert.deepEqual(choosing.votes,{});
  await call("PUT",room+"/vote",b,{...pair,version:2});
  await call("PUT",room+"/board",b,{question,phase:"thinking",version:1},409);
  assert.equal((await call("GET",room+"/boards",a)).boards.find((v:{player:string})=>v.player===b).phase,"raised");
  assert.ok((await call("GET",room+"/boards",c)).boards.every((v:{player:string})=>v.player!==b));
  assert.equal((await call("GET",room,a)).votes.find((v:{player:string})=>v.player===b).votes[question],option);
  await call("POST",room+"/messages",a,{kind:"offer",recipient:d,body:"offer"},404);
  await call("POST",room+"/messages",a,{kind:"offer",recipient:b,body:"offer"});
  assert.equal((await call("GET",room+"/messages",b)).messages.length,1);
  assert.equal((await call("GET",room+"/messages",c)).messages.length,0);
  await call("PUT",room+"/answer",b,{...pair,version:0},409);
  await db.query("UPDATE live_players SET seen=now()-interval '1 minute' WHERE room=$1 AND player=$2",[id,a]);
  const takeover=await call("GET",room,a);
  assert.equal(takeover.own.controller,b);
  await call("PUT",room+"/answer",a,{...pair,version:0},409);
  await call("PUT",room+"/answer",b,{...pair,version:takeover.own.version});
  const handback=await call("POST",room+"/handback",b);
  await call("POST",room+"/submit",a,{version:handback.version,unanswered:1},409);
  await call("POST",room+"/submit",a,{version:handback.version,unanswered:0});
  assert.equal((await call("GET",room,b)).questions[0].explanation,undefined);
  await db.query("UPDATE live_rooms SET started=now()-interval '1 hour',deadline=now()-interval '1 second' WHERE id=$1",[id]);
  await call("PUT",room+"/answer",c,{...pair,version:0},409);
  assert.equal((await call("GET",room,c)).scores[0].score,1);
  assert.equal((await call("GET","me/progress",a)).quiz.correct,1);
  assert.deepEqual((await call("GET","families/"+home+"/hall",a)).leaderboard.map((r:{points:number})=>r.points),[1,0]);
});
