import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { buildApi } from "../src/api.ts";
import { registerRoutes } from "../src/router.ts";

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
  registerRoutes(app, runtime, async cookie => cookie ? { user: { id: cookie, emailVerified: true }, session: { id: cookie } } : null, origin);
  const staff = "/api/v1/staff/courses", detail = staff+"/"+id, mine = "/api/v1/courses";
  const request = (method: "GET"|"POST"|"PUT", url: string, cookie: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie, origin }, payload });
  const sheet = {id:randomUUID(),title:"Reference sheet",body:"Review the lecture vocabulary."};
  const lesson = { id: randomUUID(), title: "Lecture", type: "video", resourceId: randomUUID(),relatedResourceIds:[sheet.id] };
  const outline = { title: "Biology", chapters: [{ id: randomUUID(), title: "Cells", lessons: [lesson] }] };
  const create = () => request("POST",staff,author,{id, productKey: product, outline: {title:"Draft",chapters:[]}});
  const read = () => request("GET",mine+"/"+id,student);
  const save = (revision: number, title: string) => request("PUT",detail,author,{revision,outline:{...outline,title}});
  const publish = (revision: number) => request("POST",detail+"/publish",author,{revision});
  await owner.query("INSERT INTO staff_members VALUES ($1)", [author]);
  assert.equal((await create()).statusCode,403);
  await owner.query("INSERT INTO academic_staff VALUES ($1)", [author]);
  const sheets="/api/v1/staff/inventory/sheets", inventory="/api/v1/inventory";
  const sheetPath=inventory+"/courses/"+id+"/lessons/"+lesson.id+"/sheets/"+sheet.id;
  assert.equal((await request("POST",sheets,student,sheet)).statusCode,403);
  assert.equal((await request("POST",sheets,author,sheet)).statusCode,200);
  const picker=staff+"/resources?kind=sheet&q="+encodeURIComponent(sheet.title.toUpperCase());
  assert.equal((await request("GET",picker,student)).statusCode,403);
  const choices=(await request("GET",picker,author)).json();
  assert.ok(choices.resources.some((r:typeof sheet & {kind:string}) =>
    r.kind==="sheet" && r.id===lesson.relatedResourceIds[0] && r.title===sheet.title && r.body===undefined));
  assert.equal((await request("POST",sheets,author,{...sheet,body:"different"})).statusCode,409);
  assert.equal((await create()).statusCode,201);
  assert.equal((await request("GET",detail,student)).statusCode,403);
  assert.equal((await request("GET",mine,"")).statusCode,401);
  assert.equal((await publish(1)).statusCode,422);
  const enroll = (key: string) => owner.query(`INSERT INTO enrollments(user_id,product_key,starts_at,ends_at)
    VALUES ($1,$2,now(),now()+interval '1 hour')`, [student,key]);
  await enroll(product);
  assert.equal((await read()).statusCode,404);
  assert.deepEqual((await request("GET",inventory,student)).json().academy,[]);
  const writes = await Promise.all([save(1,"Biology"),save(1,"Biology")]);
  assert.deepEqual(writes.map(r => r.statusCode).sort(),[200,409]);
  assert.equal((await publish(2)).statusCode,200);
  assert.equal((await request("GET",inventory,student)).json().academy[0].href,sheetPath);
  assert.deepEqual((await request("GET",sheetPath,student)).json(),sheet);
  const saved="/api/v1/me/saved";
  const lessonMark={kind:"lesson",source:id,target:lesson.id,saved:true};
  const sheetMark={kind:"sheet",source:id,target:sheet.id,lesson:lesson.id,saved:true};
  for(const mark of [lessonMark,sheetMark,lessonMark]) assert.equal((await request("PUT",saved,student,mark)).statusCode,200);
  assert.equal((await request("GET",saved,student)).json().items.length,2);
  assert.equal((await publish(2)).statusCode,200);
  assert.equal((await save(2,"Revised")).statusCode,200);
  assert.equal((await read()).json().outline.title,"Biology");
  assert.deepEqual((await request("GET",mine,student)).json().courses,[{id,revision:2,title:"Biology"}]);
  assert.equal((await publish(1)).statusCode,409);
  assert.equal((await publish(3)).statusCode,200);
  assert.equal((await read()).json().outline.title,"Revised");
  assert.equal((await request("GET",detail+"?revision=2",author)).json().outline.title,"Biology");
  const follow = { ...lesson, id:randomUUID(), resourceId:randomUUID(), prerequisiteIds:[lesson.id] };
  const future = { ...lesson, id:randomUUID(), resourceId:randomUUID(), releaseAt:"2099-01-01T00:00:00Z" };
  const newDraft = (revision:number, lessons:object[]) => request("PUT", detail, author, {
    revision, outline:{...outline, chapters:[{...outline.chapters[0], lessons}]}
  });
  assert.equal((await newDraft(3,[{...lesson, prerequisiteIds:[follow.id]}, follow])).statusCode,200);
  assert.equal((await publish(4)).statusCode,422);
  assert.equal((await newDraft(4,[lesson,follow,future])).statusCode,200);
  assert.equal((await publish(5)).statusCode,200);
  const path = (lessonId:string) => mine+"/"+id+"/lessons/"+lessonId;
  const open = (lessonId:string) => request("GET",path(lessonId),student);
  const mark = (lessonId:string, version:number, completed:boolean, revision=5) =>
    request("PUT",path(lessonId)+"/progress",student,{revision,version,completed,position:{videoSeconds:45}});
  const detailResponse = (await read()).json();
  assert.equal(detailResponse.continueLessonId,lesson.id);
  assert.equal(detailResponse.outline.chapters[0].lessons[1].resourceId,undefined);
  assert.equal((await open(follow.id)).statusCode,403);
  assert.equal((await mark(follow.id,0,true)).statusCode,403);
  assert.equal((await open(future.id)).statusCode,403);
  assert.equal((await request("GET",inventory+"/courses/"+id+"/lessons/"+future.id+"/sheets/"+sheet.id,student)).statusCode,403);
  const saves = await Promise.all([mark(lesson.id,0,false),mark(lesson.id,0,false)]);
  assert.deepEqual(saves.map(res=>res.statusCode).sort(),[200,409]);
  assert.deepEqual((await open(lesson.id)).json().position,{videoSeconds:45});
  assert.equal((await mark(lesson.id,1,true)).statusCode,200);
  assert.equal((await read()).json().continueLessonId,follow.id);
  assert.equal((await open(follow.id)).statusCode,200);
  assert.equal((await mark(lesson.id,2,false)).json().completed,true);
  assert.equal((await newDraft(5,[{...lesson, resourceId:randomUUID()},follow,future])).statusCode,200);
  assert.equal((await publish(6)).statusCode,200);
  assert.equal((await request("GET",saved,student)).json().items[0].state,"changed");
  assert.equal((await open(lesson.id)).json().version,0);
  assert.equal((await open(follow.id)).statusCode,403);
  assert.equal((await mark(lesson.id,0,true)).statusCode,409);
  await enroll(randomUUID());
  for (const change of ["starts_at=now()+interval '1 minute'", "starts_at=now()-interval '1 hour', ends_at=now()",
    "ends_at=now()+interval '1 hour',revoked_at=now()"]) {
    await owner.query("UPDATE enrollments SET "+change+" WHERE user_id=$1 AND product_key=$2",[student,product]);
    assert.equal((await read()).statusCode,404);
    assert.equal((await open(lesson.id)).statusCode,404);
    assert.equal((await request("GET",sheetPath,student)).statusCode,404);
    assert.deepEqual((await request("GET",inventory,student)).json().academy,[]);
    const bookmarks=(await request("GET",saved,student)).json().items;
    assert.ok(bookmarks.every((item:{state:string;href?:string;title?:string})=>item.state==="unavailable" && !item.href && !item.title));
    assert.equal((await mark(lesson.id,0,true,6)).statusCode,404);
    assert.deepEqual((await request("GET",mine,student)).json().courses,[]);
  }
  await owner.query("INSERT INTO temporary_credentials VALUES ($1, now()+interval '1 day')", [author]);
  assert.equal((await request("PUT",saved,student,{...lessonMark,saved:false})).statusCode,200);
  assert.equal((await save(3,"Blocked")).statusCode,403);
});
