import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { buildApi } from "../src/api.ts";
import { registerCurriculum } from "../src/curriculum.ts";

test("academic revisions publish atomically and follow current enrollment", { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const connectionString = process.env.TEST_DATABASE_URL;
  const owner = new Pool({ connectionString });
  const runtime = new Pool({ connectionString, options: "-c role=zy2_api" });
  const app = buildApi(async () => []);
  t.after(async () => { await app.close(); await runtime.end(); await owner.end(); });
  const author = randomUUID(), student = randomUUID(), id = randomUUID(), product = randomUUID();
  for (const user of [author, student]) {
    await owner.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES ($1,$1,$2,true)', [user,user+"@example.org"]);
    await owner.query('INSERT INTO session(id,"userId",token,"createdAt","updatedAt","expiresAt") VALUES ($1,$1,$1,now(),now(),now()+interval \'1 hour\')', [user]);
  }
  const origin = "http://localhost";
  registerCurriculum(app, runtime, async cookie => cookie ? { user: { id: cookie, emailVerified: true }, session: { id: cookie } } : null, origin);
  const staff = "/api/v1/staff/courses", detail = staff+"/"+id, mine = "/api/v1/courses";
  const request = (method: "GET"|"POST"|"PUT", url: string, cookie: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie, origin }, payload });
  const lesson = { id: randomUUID(), title: "Lecture", type: "video", resourceId: randomUUID() };
  const outline = { title: "Biology", chapters: [{ id: randomUUID(), title: "Cells", lessons: [lesson] }] };
  const create = () => request("POST",staff,author,{id, productKey: product, outline: {title:"Draft",chapters:[]}});
  const read = () => request("GET",mine+"/"+id,student);
  const save = (revision: number, title: string) => request("PUT",detail,author,{revision,outline:{...outline,title}});
  const publish = (revision: number) => request("POST",detail+"/publish",author,{revision});
  await owner.query("INSERT INTO staff_members VALUES ($1)", [author]);
  assert.equal((await create()).statusCode,403);
  await owner.query("INSERT INTO academic_staff VALUES ($1)", [author]);
  assert.equal((await create()).statusCode,201);
  assert.equal((await request("GET",detail,student)).statusCode,403);
  assert.equal((await request("GET",mine,"")).statusCode,401);
  assert.equal((await publish(1)).statusCode,422);
  const enroll = (key: string) => owner.query(`INSERT INTO enrollments(user_id,product_key,starts_at,ends_at)
    VALUES ($1,$2,now(),now()+interval '1 hour')`, [student,key]);
  await enroll(product);
  assert.equal((await read()).statusCode,404);
  const writes = await Promise.all([save(1,"Biology"),save(1,"Biology")]);
  assert.deepEqual(writes.map(r => r.statusCode).sort(),[200,409]);
  assert.equal((await publish(2)).statusCode,200);
  assert.equal((await publish(2)).statusCode,200);
  assert.equal((await save(2,"Revised")).statusCode,200);
  assert.equal((await read()).json().outline.title,"Biology");
  assert.deepEqual((await request("GET",mine,student)).json().courses,[{id,revision:2,title:"Biology"}]);
  assert.equal((await publish(1)).statusCode,409);
  assert.equal((await publish(3)).statusCode,200);
  assert.equal((await read()).json().outline.title,"Revised");
  assert.equal((await request("GET",detail+"?revision=2",author)).json().outline.title,"Biology");
  await enroll(randomUUID());
  for (const change of ["starts_at=now()+interval '1 minute'", "starts_at=now()-interval '1 hour', ends_at=now()",
    "ends_at=now()+interval '1 hour',revoked_at=now()"]) {
    await owner.query("UPDATE enrollments SET "+change+" WHERE user_id=$1 AND product_key=$2",[student,product]);
    assert.equal((await read()).statusCode,404);
    assert.deepEqual((await request("GET",mine,student)).json().courses,[]);
  }
  await owner.query("INSERT INTO temporary_credentials VALUES ($1, now()+interval '1 day')", [author]);
  assert.equal((await save(3,"Blocked")).statusCode,403);
});
