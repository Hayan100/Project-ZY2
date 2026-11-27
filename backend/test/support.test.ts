import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { buildApi } from "../src/api.ts";
import { registerCurriculum } from "../src/curriculum.ts";

test("private tickets retain history and restrict complaint and escalation queues", {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const connectionString = process.env.TEST_DATABASE_URL;
  const db = new Pool({connectionString});
  const runtime = new Pool({connectionString, options:"-c role=zy2_api"});
  const app = buildApi(async () => []);
  t.after(async () => { await app.close(); await runtime.end(); await db.end(); });
  const [student, peer, reviewer, senior, reported] = Array.from({length:5}, () => randomUUID());
  for (const id of [student, peer, reviewer, senior, reported]) {
    await db.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES ($1,$1,$2,true)', [id,id+"@example.org"]);
    await db.query(`INSERT INTO session(id,"userId",token,"createdAt","updatedAt","expiresAt")
      VALUES($1,$1,$1,now(),now(),now()+interval '1 hour')`, [id]);
  }
  for (const id of [reviewer, senior, reported]) await db.query("INSERT INTO staff_members VALUES($1)", [id]);
  await db.query(`INSERT INTO support_reviewers VALUES ($1,'technical',false),($2,'technical',true),
    ($2,'service_complaint',true),($3,'service_complaint',true)`, [reviewer,senior,reported]);
  registerCurriculum(app,runtime,async cookie => cookie ? {user:{id:cookie,emailVerified:true},session:{id:cookie}} : null,"http://localhost");
  async function call(cookie:string, path:string, payload?:object, status=200) {
    const res = await app.inject({method:payload ? "POST" : "GET", url:"/api/v1/"+path, headers:{cookie}, payload});
    assert.equal(res.statusCode,status,path+" "+res.body);
    return res.json();
  }
  const mine = "support/tickets", queue = "staff/"+mine;
  await call("","support/help",undefined,401);
  const help = await call(student,"support/help?q=READER&pageIgnored=true&category=technical");
  assert.equal(help.articles.length,1);
  assert.equal(help.tickets,"/api/v1/support/tickets");
  await call(student,"support/help?q="+"x".repeat(121),undefined,400);
  const body = {id:randomUUID(),category:"technical",subject:"Reader",description:"Page stops loading"};
  await call(student,mine,body);
  assert.deepEqual((await call(peer,"support/help?q=Page%20stops%20loading")).articles,[]);
  await call(student,mine,body);
  await call(student,mine,{...body,subject:"Changed"},409);
  const item = "/"+body.id;
  await call(peer,mine+item,undefined,404);
  const event = (actor:string, base:string, version:number, action:string, status=200) =>
    call(actor,base+item+"/events",{version,action,message:action+" details"},status);
  await event(reviewer,queue,0,"claim");
  await event(reviewer,queue,0,"claim");
  await event(senior,queue,0,"reply",409);
  await event(student,mine,1,"reply");
  await event(reviewer,queue,2,"escalate");
  await call(reviewer,queue+item,undefined,404);
  await event(senior,queue,3,"resolve");
  await event(student,mine,4,"reply",409);
  await event(student,mine,4,"reopen");
  const thread = await call(student,mine+item);
  assert.equal(thread.resolved,false);
  assert.deepEqual(thread.events.map((e:{action:string})=>e.action),["claim","reply","escalate","resolve","reopen"]);
  const complaint = {...body,id:randomUUID(),category:"service_complaint",reportedStaff:reported};
  await call(student,mine,complaint);
  for (const actor of [peer,reviewer,reported]) {
    const list = await call(actor,queue);
    assert.ok(!list.tickets.some((row:{id:string})=>row.id===complaint.id));
    await call(actor,queue+"/"+complaint.id,undefined,404);
  }
  assert.equal((await call(senior,queue+"/"+complaint.id)).description,complaint.description);
  await event(senior,queue,5,"claim");
  await db.query("DELETE FROM support_reviewers WHERE reviewer=$1 AND category='technical'",[senior]);
  await db.query("UPDATE support_reviewers SET senior=true WHERE reviewer=$1 AND category='technical'",[reviewer]);
  await event(reviewer,queue,6,"claim");
  await event(reviewer,queue,7,"resolve");
});
