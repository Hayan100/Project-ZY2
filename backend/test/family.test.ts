import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {buildApi} from "../src/api.ts";
import {registerCurriculum} from "../src/curriculum.ts";

test("family chat, Hall, opt-in ranking and transfers follow the current shared-space entitlement",{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const connectionString=process.env.TEST_DATABASE_URL;
  const db=new Pool({connectionString}),runtime=new Pool({connectionString,options:"-c role=zy2_api"});
  const app=buildApi(async()=>[]);
  t.after(async()=>{await app.close();await runtime.end();await db.end();});
  const [ops,one,two,alice,bob,other,outsider]=Array.from({length:7},()=>randomUUID());
  for(const id of [ops,one,two,alice,bob,other,outsider]){
    await db.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',[id,id+"@example.org"]);
    await db.query(`INSERT INTO session(id,"userId",token,"createdAt","updatedAt","expiresAt") VALUES($1,$1,$1,now(),now(),now()+interval '2 hours')`,[id]);
  }
  for(const id of [ops,one,two]) await db.query("INSERT INTO staff_members VALUES($1)",[id]);
  await db.query("INSERT INTO welcome_admins VALUES($1)",[ops]);
  registerCurriculum(app,runtime,async cookie=>cookie?{user:{id:cookie,emailVerified:true},session:{id:cookie}}:null,"http://localhost");
  const req=(method:"GET"|"POST"|"PUT",p:string,user:string,payload?:object)=>app.inject({method,url:"/api/v1/"+p,headers:{cookie:user},payload});
  const get=(p:string,user=alice)=>req("GET",p,user);
  const post=(p:string,user:string,b:object={})=>req("POST",p,user,b);
  const put=(p:string,user:string,b:object)=>req("PUT",p,user,b);
  const product=randomUUID(),home=randomUUID(),away=randomUUID(),base="families/"+home;
  const studentGrant=randomUUID();
  await db.query("INSERT INTO welcome_products(product_key,route) VALUES($1,'mentored')",[product]);
  for(const [i,id] of [one,two].entries()) await db.query("INSERT INTO ghazis VALUES($1,$2,6,true,'Teaching','Weekdays',60)",[id,100+i]);
  for(const [student,ghazi] of [[alice,one],[bob,one],[other,two]]){
    const enrollment=student===alice?studentGrant:randomUUID();
    await db.query(`INSERT INTO enrollments(id,user_id,product_key,starts_at,ends_at) VALUES($1,$2,$3,now()-interval '2 days',now()+interval '1 week')`,
      [enrollment,student,product]);
    await db.query("INSERT INTO ghazi_assignments(enrollment_id,version,mentor_id,assigned_by) VALUES($1,1,$2,$3)",[enrollment,ghazi,ops]);
  }
  for(const [id,ghazi] of [[home,one],[away,two]]) {
    const body={id,name:id===home?"North":"South",mentorId:ghazi,productKey:product};
    assert.equal((await post("staff/families",ghazi,body)).statusCode,403);
    assert.equal((await post("staff/families",ops,body)).statusCode,200);
  }
  assert.deepEqual((await get("me/families",outsider)).json().families,[]);
  assert.equal((await get(base,ops)).statusCode,404);
  assert.equal((await get(base+"/hall",other)).statusCode,404);
  const overview=await get(base);
  assert.equal(overview.statusCode,200,overview.body);
  assert.equal(overview.json().members.length,3);
  assert.ok(overview.json().ghaziContact.url.includes(studentGrant));
  assert.equal((await get("onboarding/"+studentGrant,bob)).statusCode,404);
  const msg={id:randomUUID(),text:"Welcome to our study group"};
  assert.equal((await post(base+"/messages",alice,msg)).statusCode,200);
  assert.equal((await post(base+"/messages",alice,msg)).statusCode,200);
  assert.equal((await get(base+"/messages",bob)).json().messages.length,1);
  assert.equal((await put("me/family-presence",alice,{sharing:true,focused:false,activity:"lecture",subject:"Biology"})).statusCode,200);
  const hints=(await get("me/camp",bob)).json().familyPresence[0].members;
  assert.equal(hints.find((m:{id:string})=>m.id===alice).subject,"Biology");
  assert.equal((await put(base+"/nudges",alice,{recipient:bob})).statusCode,200);
  await put("me/family-presence",bob,{sharing:false,focused:true});
  assert.deepEqual((await get(base+"/nudges",bob)).json().nudges,[]);
  assert.deepEqual((await get("me/camp",bob)).json().familyPresence,[]);
  await put("me/family-presence",bob,{sharing:false,focused:false});
  assert.equal((await get(base+"/nudges",bob)).json().nudges.length,1);
  await put("me/family-presence",alice,{sharing:false,focused:false});
  assert.equal((await get(base,bob)).json().members.find((m:{id:string})=>m.id===alice).subject,null);
  await db.query(`INSERT INTO planner_tasks(id,student_id,created_by,title,starts_at,minutes,fixed,completed_at)
    VALUES($1,$2,$2,'Confidential reflection',now(),10,false,now())`,[randomUUID(),alice]);
  assert.equal((await put(base+"/weekly-goal",one,{title:"Finish study tasks",target:10,version:0})).statusCode,200);
  assert.equal((await put(base+"/weekly-goal",one,{title:"Stale",target:1,version:0})).statusCode,409);
  let hall=(await get(base+"/hall",bob)).json();
  assert.equal(hall.week.completedTasks,1);
  assert.equal(JSON.stringify(hall).includes("Confidential reflection"),false);
  const nomination=randomUUID(),term=new Date(Date.now()+7*86400000).toISOString();
  assert.equal((await post(base+"/captain/volunteer",alice,{id:nomination})).statusCode,200);
  assert.equal((await post(base+"/captain/approve",bob,{volunteerId:nomination,endsAt:term})).statusCode,403);
  assert.equal((await post(base+"/captain/approve",one,{volunteerId:nomination,endsAt:term})).statusCode,200);
  assert.equal((await get(base)).json().captain.memberId,alice);
  assert.equal((await post("staff/families/"+home+"/awards",ops,{id:randomUUID(),title:"Teamwork",kind:"trophy",memberId:bob})).statusCode,200);
  const events=[randomUUID(),randomUUID()];
  for(const [index,id] of events.entries()){
    const event={id,away,title:"Weekend practice",opensAt:new Date(Date.now()+3600000).toISOString(),closesAt:term};
    assert.equal((await post(base+"/challenges",alice,event)).statusCode,200);
    const staffPath="staff/families/challenges/"+id;
    if(index===0) assert.equal((await post(staffPath+"/rank",ops)).statusCode,200);
    const entry=base+"/challenges/"+id+"/entry";
    assert.equal((await put(entry,one,{join:true})).statusCode,403);
    assert.equal((await put(entry,alice,{join:true})).statusCode,200);
    assert.equal((await put(entry,alice,{join:false})).statusCode,200);
    assert.equal((await put(entry,bob,{join:true})).statusCode,200);
    assert.equal((await put("families/"+away+"/challenges/"+id+"/entry",other,{join:true})).statusCode,200);
    assert.equal((await post(staffPath+"/rank",ops)).statusCode,409);
    assert.equal((await put(staffPath+"/result",ops,{homePoints:3,awayPoints:1})).statusCode,409);
    await db.query("UPDATE family_events SET opens_at=now()-interval '1 day',closes_at=now()-interval '1 minute' WHERE id=$1",[id]);
    const result=await put(staffPath+"/result",ops,{homePoints:3,awayPoints:1});
    assert.equal(result.statusCode,200,result.body);
    assert.equal((await put(staffPath+"/result",ops,{homePoints:4,awayPoints:1})).statusCode,409);
  }
  hall=(await get(base+"/hall")).json();
  assert.equal(hall.awards[0].title,"Teamwork");
  assert.deepEqual(hall.leaderboard.map((r:{points:number})=>r.points),[3,1]);
  assert.equal((await post(base+"/captain/step-down",alice)).statusCode,200);
  assert.equal((await get(base)).json().captain,null);
  await db.query("UPDATE enrollments SET revoked_at=now() WHERE id=$1",[studentGrant]);
  assert.equal((await get(base+"/messages")).statusCode,404);
  assert.equal((await get(base+"/hall")).statusCode,404);
  await db.query("UPDATE enrollments SET revoked_at=NULL WHERE id=$1",[studentGrant]);
  assert.equal((await get(base+"/messages")).json().messages[0].id,msg.id);
  const restrict=(restricted:boolean)=>put("staff/families/"+home+"/restrictions",ops,{memberId:alice,restricted});
  assert.equal((await restrict(true)).statusCode,200);
  assert.equal((await get(base+"/messages")).statusCode,404);
  assert.equal((await restrict(false)).statusCode,200);
  const transfer=await put("staff/onboarding/cases/"+studentGrant+"/assignment",ops,{version:1,mentorId:two});
  assert.equal(transfer.statusCode,200,transfer.body);
  assert.equal((await get(base+"/messages")).statusCode,404);
  assert.equal((await get("families/"+away)).statusCode,200);
  assert.equal((await get(base+"/nudges",bob)).json().nudges.length,0);
});
