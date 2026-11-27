import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createServer} from "node:http";
import {Pool} from "pg";
import {buildApi} from "../src/api.ts";
import {registerCurriculum} from "../src/curriculum.ts";

test("Community gates Stoat, academic discussions, consent and appeals; library seats survive view switches",{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const cs=process.env.TEST_DATABASE_URL,db=new Pool({connectionString:cs}),runtime=new Pool({connectionString:cs,options:"-c role=zy2_api"});
  const app=buildApi(async()=>[]);
  t.after(async()=>{await app.close();await runtime.end();await db.end();});
  const people=Array.from({length:28},()=>randomUUID()),[mod,reviewer,a,b,c]=people;
  for(const id of people){
    await db.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',[id,id+"@example.org"]);
    await db.query(`INSERT INTO session(id,"userId",token,"createdAt","updatedAt","expiresAt") VALUES($1,$1,$1,now(),now(),now()+interval '1 hour')`,[id]);
  }
  for(const id of [mod,reviewer]) {
    await db.query("INSERT INTO staff_members VALUES($1)",[id]);await db.query("INSERT INTO community_moderators VALUES($1)",[id]);
  }
  await db.query("INSERT INTO academic_staff VALUES($1)",[reviewer]);await db.query("INSERT INTO doubt_staff VALUES($1,'Physics')",[reviewer]);
  registerCurriculum(app,runtime,async cookie=>cookie?{user:{id:cookie,emailVerified:true},session:{id:cookie}}:null,"http://localhost");
  async function call(method:"POST"|"GET"|"PUT"|"DELETE",url:string,user:string,payload?:object,status=200){
    const res=await app.inject({method,url:"/api/v1/"+url,headers:{cookie:user},payload});
    assert.equal(res.statusCode,status,url+" "+res.body);return res.json();
  }
  const product=randomUUID(),paid=randomUUID(),subject=randomUUID(),quiet=randomUUID(),social=randomUUID(),channel="0123456789ABCDEFGHJKMNPQRS";
  const api=createServer(async(req,res)=>{
    assert.equal(req.headers["x-bot-token"],"test-only");
    assert.ok(req.url?.startsWith("/channels/"+channel+"/messages"));
    if(req.method==="POST"){
      let raw="";for await(const part of req) raw+=part;
      assert.equal(JSON.parse(raw).content,"Hello classmates");assert.ok(req.headers["idempotency-key"]);
    }
    res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({_id:"message1",channel,content:"Hello classmates"}));
  });
  await new Promise<void>(resolve=>api.listen(0,"127.0.0.1",resolve));
  const address=api.address();assert.ok(address&&typeof address==="object");
  process.env.STOAT_API_URL="http://127.0.0.1:"+address.port;process.env.STOAT_BOT_TOKEN="test-only";
  t.after(()=>new Promise<void>(resolve=>api.close(()=>resolve())));
  const make=(body:object)=>call("POST","staff/community/spaces",mod,body);
  await make({id:paid,name:"Batch chat",product,kind:"general",stoatChannel:channel});
  await make({id:subject,name:"Physics",kind:"academic",subject:"Physics"});
  await make({id:quiet,name:"Desks",kind:"quiet",capacity:24,instances:1});
  await make({id:social,name:"Lounge",kind:"social",capacity:1,instances:2});
  await db.query("INSERT INTO enrollments(id,user_id,product_key,starts_at,ends_at) VALUES($1,$2,$3,now()-interval '1 day',now()+interval '1 day')",[randomUUID(),a,product]);
  const chat="community/channels/"+paid,post=randomUUID();
  await call("POST",chat+"/posts",a,{id:post,text:"Hello classmates"});
  await call("PUT",chat+"/follow",a,{follow:true});
  assert.equal((await call("GET",chat+"/posts",a)).posts[0].body,"Hello classmates");
  assert.equal((await call("GET","community",a)).followed.length,1);
  await db.query("UPDATE enrollments SET revoked_at=now() WHERE user_id=$1",[a]);
  await call("GET",chat+"/posts",a,undefined,404);assert.deepEqual((await call("GET","community",a)).followed,[]);
  await db.query("UPDATE enrollments SET revoked_at=NULL WHERE user_id=$1",[a]);
  assert.equal((await call("GET",chat+"/posts",a)).posts[0].id,post);
  const doubt=randomUUID(),reply=randomUUID(),doubts="community/channels/"+subject+"/posts";
  await call("POST",doubts,b,{id:doubt,text:"Why is momentum conserved?"});
  assert.equal((await call("GET",doubts+"?q=momentum",a)).posts.length,1);
  assert.ok((await call("GET","staff/community/doubts",reviewer)).doubts.some((p:{id:string})=>p.id===doubt));
  await call("POST","staff/community/doubts/"+doubt+"/reply",reviewer,{id:reply,text:"Check the net external impulse."});
  assert.equal((await call("GET",doubts,a)).posts[0].verified_by,reviewer);
  const dm="community/dms/"+(await call("POST","community/dms",a,{peer:b})).id;
  await call("GET",dm+"/posts",b,undefined,404);await call("PUT",dm+"/accept",a,{},404);await call("PUT",dm+"/accept",b,{});
  const msg=randomUUID();await call("POST",dm+"/posts",a,{id:msg,text:"Hello"});
  const report=await call("POST","community/reports",b,{post:msg,reason:"Review"});
  const action=await call("POST","staff/community/reports/"+report.id+"/action",mod,{kind:"mute",reason:"Cooldown",hours:1});
  await call("POST",dm+"/posts",a,{id:randomUUID(),text:"Blocked"},403);
  await call("PUT","community/actions/"+action.id+"/appeal",a,{reason:"Please review"});
  await call("PUT","staff/community/actions/"+action.id+"/decision",reviewer,{reason:"Restored",overturn:true});
  await call("PUT","community/block",b,{peer:a,block:true});await call("GET",dm+"/posts",a,undefined,404);
  const enter=(id:string,user:string,body={})=>call("POST","library/rooms/"+id+"/join",user,body);
  const arrivals=await Promise.all(people.map(p=>enter(quiet,p)));
  assert.equal(arrivals.filter(d=>d.status==="joined").length,24);
  assert.equal(arrivals.filter(d=>d.status==="full").length,4);
  const index=arrivals.findIndex(d=>d.status==="joined"),user=people[index],seat="library/desks/"+arrivals[index].id;
  assert.equal((await enter(quiet,user)).id,arrivals[index].id);
  const timer=await call("PUT",seat+"/focus",user,{minutes:25});assert.equal((await call("GET",seat,user)).focusEnd,timer.focus_end);
  await call("PUT",seat+"/voice",user,{enabled:true},403);
  const lounge=await enter(social,b),seat2="library/desks/"+lounge.id;
  const next=await enter(social,c);assert.notEqual(next.instance,lounge.instance);
  assert.equal((await enter(social,c,{joinPeer:b})).status,"unavailable");
  await call("PUT",seat2+"/voice",b,{enabled:true});
  await call("POST",seat2+"/signals",b,{peer:c,kind:"ice",body:"candidate"},404);
  const comment=await call("POST",seat2+"/chat",b,{text:"Study break"});
  assert.equal((await call("GET",seat2+"/chat",b)).messages[0].id,comment.id);
  const family=randomUUID(),ghazi=people[6],familyRoom=randomUUID();
  await db.query("INSERT INTO staff_members VALUES($1)",[ghazi]);
  await db.query("INSERT INTO ghazis VALUES($1,1700,8,true,'Teaching','Weekdays',60)",[ghazi]);
  await db.query("INSERT INTO welcome_products(product_key,route) VALUES($1,'mentored')",[product]);
  await db.query("INSERT INTO families(id,name,mentor_id,product_key,created_by) VALUES($1,'Study group',$2,$3,$4)",[family,ghazi,product,mod]);
  for(const student of [b,c]){
    const grant=randomUUID();
    await db.query("INSERT INTO enrollments(id,user_id,product_key,starts_at,ends_at) VALUES($1,$2,$3,now()-interval '1 day',now()+interval '1 day')",[grant,student,product]);
    await db.query("INSERT INTO ghazi_assignments(enrollment_id,version,mentor_id,assigned_by) VALUES($1,1,$2,$3)",[grant,ghazi,mod]);
  }
  await make({id:familyRoom,name:"Family desk",kind:"quiet",product,capacity:1,instances:1});
  await enter(familyRoom,c);
  assert.equal((await enter(familyRoom,ghazi,{joinPeer:c})).status,"joined");
  assert.equal((await enter(familyRoom,b)).status,"full");
  assert.equal((await enter(familyRoom,b,{joinPeer:c})).status,"joined");
  await call("POST","library/rooms/"+familyRoom+"/invite",mod,{peer:people[10]});
  assert.equal((await enter(familyRoom,people[10])).status,"unavailable");
  await call("PUT","staff/library/rooms/"+familyRoom+"/capacity",mod,{capacity:2});
  await call("DELETE",seat2,b);await call("GET",seat2,b,undefined,404);
});
