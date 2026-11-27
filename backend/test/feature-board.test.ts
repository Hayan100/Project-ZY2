import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { buildApi } from "../src/api.ts";
import { registerCurriculum } from "../src/curriculum.ts";

test("feature suggestions require review, count distinct votes and protect staff updates", {skip:!process.env.TEST_DATABASE_URL}, async t => {
  const connectionString = process.env.TEST_DATABASE_URL;
  const db = new Pool({connectionString});
  const runtime = new Pool({connectionString,options:"-c role=zy2_api"});
  const app = buildApi(async () => []);
  t.after(async () => {await app.close(); await runtime.end(); await db.end();});
  const [student,peer,reviewer] = Array.from({length:3},()=>randomUUID());
  for (const id of [student,peer,reviewer]) {
    await db.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',[id,id+"@example.org"]);
    await db.query(`INSERT INTO session(id,"userId",token,"createdAt","updatedAt","expiresAt")
      VALUES($1,$1,$1,now(),now(),now()+interval '1 hour')`,[id]);
  }
  await db.query("INSERT INTO staff_members VALUES($1)",[reviewer]);
  await db.query("INSERT INTO community_moderators VALUES($1)",[reviewer]);
  registerCurriculum(app,runtime,async cookie=>cookie ? {user:{id:cookie,emailVerified:true},session:{id:cookie}} : null,"http://localhost");
  async function call(user:string,method:"GET"|"POST"|"PUT",url:string,payload?:object,status=200) {
    const res = await app.inject({method,url:"/api/v1/"+url,headers:{cookie:user},payload});
    assert.equal(res.statusCode,status,res.body);
    return res.json();
  }
  const board="feature-suggestions", staff="staff/"+board;
  const idea={id:randomUUID(),title:"Keyboard navigation",description:"Jump to the next chapter"};
  const vote=board+"/"+idea.id+"/vote", update=staff+"/"+idea.id+"/status";
  const find=async(user:string,path=board)=>(await call(user,"GET",path)).suggestions.find((s:{id:string})=>s.id===idea.id);
  await call("","GET",board,undefined,401);
  assert.equal((await call(student,"POST",board,idea)).status,"submitted");
  await call(student,"POST",board,idea);
  await call(peer,"POST",board,idea,409);
  assert.ok((await find(student)).mine);
  assert.equal(await find(peer),undefined);
  assert.equal((await find(reviewer,staff)).status,"submitted");
  await call(peer,"PUT",vote,{voted:true},404);
  await call(student,"PUT",update,{version:0,status:"planned"},403);
  await call(reviewer,"PUT",update,{version:0,status:"under_review"});
  await call(reviewer,"PUT",update,{version:0,status:"under_review"});
  await call(reviewer,"PUT",update,{version:0,status:"delivered"},409);
  await Promise.all([peer,peer,student].map(user=>call(user,"PUT",vote,{voted:true})));
  assert.equal((await find(peer)).votes,2);
  assert.ok((await find(peer)).voted);
  await call(peer,"PUT",vote,{voted:false});
  await call(peer,"PUT",vote,{voted:false});
  assert.equal((await find(peer)).votes,1);
  for (const [index,status] of ["planned","in_progress","delivered","declined"].entries())
    await call(reviewer,"PUT",update,{version:index+1,status});
  assert.equal(await find(peer),undefined);
  assert.equal((await find(student)).status,"declined");
  await call(peer,"PUT",vote,{voted:true},404);
});
