import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { buildApi } from "../src/api.ts";
import { registerRoutes } from "../src/router.ts";

test("published ebooks share stable pages and reading state across authorized entry points",
  {skip:!process.env.TEST_DATABASE_URL},async t=>{
  const connectionString=process.env.TEST_DATABASE_URL;
  const owner=new Pool({connectionString});
  const runtime=new Pool({connectionString, options:"-c role=zy2_api"});
  const app=buildApi(async()=>[]);
  t.after(async()=>{await app.close(); await runtime.end(); await owner.end();});
  const staff=randomUUID(), student=randomUUID(), course=randomUUID(), lesson=randomUUID(), book=randomUUID();
  const courseKey=randomUUID(), libraryKey=randomUUID();
  for (const id of [staff,student]) {
    await owner.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES ($1,$1,$2,true)',[id,id+"@example.org"]);
    await owner.query(`INSERT INTO session(id,"userId",token,"createdAt","updatedAt","expiresAt")
      VALUES ($1,$1,$1,now(),now(),now()+interval '1 hour')`,[id]);
  }
  await owner.query("INSERT INTO staff_members VALUES ($1)",[staff]);
  await owner.query("INSERT INTO academic_staff VALUES ($1)",[staff]);
  const enroll=(key:string)=>owner.query(`INSERT INTO enrollments(user_id,product_key,starts_at,ends_at)
    VALUES ($1,$2,now(),now()+interval '1 hour')`,[student,key]);
  registerRoutes(app,runtime,async cookie=>cookie?{user:{id:cookie,emailVerified:true},session:{id:cookie}}:null,"http://localhost");
  const request=(method:"GET"|"POST"|"PUT",path:string,cookie:string,payload?:object)=>
    app.inject({method,url:"/api/v1/"+path,headers:{cookie},payload});
  const author="staff/ebooks", library="ebooks/"+book;
  const context="?courseId="+course+"&lessonId="+lesson;
  const page={id:randomUUID(),title:"Cell walls",blocks:[{type:"paragraph",text:"Cellulose provides structure."}]};
  const manuscript={title:"Biology",exam:"MDCAT",subject:"Botany",pages:[page]};
  const create={id:book,libraryProductKey:libraryKey,manuscript};
  assert.equal((await request("POST",author,student,create)).statusCode,403);
  assert.equal((await request("POST",author,staff,create)).statusCode,201);
  const publish=(revision:number)=>request("POST",author+"/"+book+"/publish",staff,{revision});
  const get=(path:string)=>request("GET",path,student);
  const lessonDoc={id:lesson,title:"Cells",type:"video",resourceId:randomUUID(),relatedResourceIds:[book]};
  const outline={title:"Intro",chapters:[{id:randomUUID(),title:"Botany",lessons:[lessonDoc]}]};
  assert.equal((await request("POST","staff/courses",staff,{id:course,productKey:courseKey,outline})).statusCode,201);
  const courseStaff="staff/courses/"+course;
  assert.equal((await request("POST",courseStaff+"/publish",staff,{revision:1})).statusCode,200);
  await enroll(courseKey);
  assert.equal((await get(library+context)).statusCode,404);
  assert.equal((await publish(1)).statusCode,200);
  assert.deepEqual((await get("ebooks")).json().ebooks,[]);
  assert.equal((await get(library)).statusCode,404);
  assert.equal((await get(library+"?courseId="+course)).statusCode,400);
  const pagePath=library+"/pages/"+page.id;
  assert.deepEqual((await get(pagePath+context)).json().page,page);
  const bookmark={kind:"page",source:book,target:page.id,course,lesson,saved:true};
  assert.equal((await request("PUT","me/saved",student,bookmark)).statusCode,200);
  assert.equal((await get("me/saved")).json().items[0].href,"/api/v1/"+pagePath+context);
  assert.deepEqual((await request("GET","me/saved",staff)).json().items,[]);
  assert.equal((await request("PUT",pagePath+"/reading"+context,student,{revision:1,studied:true})).statusCode,200);
  await enroll(libraryKey);
  assert.deepEqual((await get("ebooks?q=botany")).json().ebooks,[{id:book,revision:1,title:"Biology",exam:"MDCAT",subject:"Botany",
    resumePageId:page.id,visited:1,studied:1,totalPages:1}]);
  assert.deepEqual((await get(library+"/search?q=CELLULOSE")).json().pages,[{id:page.id,title:page.title}]);
  assert.equal((await get(library)).json().pages[0].studied,true);
  assert.equal((await request("PUT",pagePath+"/reading",student,{revision:1})).json().studied,true);
  const replacement={...page,title:"New page",id:randomUUID()};
  const replace=(revision:number,pages:typeof page[])=>request("PUT",author+"/"+book,staff,{revision,manuscript:{...manuscript,pages}});
  assert.equal((await replace(1,[page,page])).statusCode,400);
  assert.equal((await replace(1,[replacement])).statusCode,200);
  assert.equal((await replace(1,[])).statusCode,409);
  assert.equal((await get(pagePath)).statusCode,200);
  assert.equal((await publish(2)).statusCode,200);
  assert.equal((await get(pagePath)).statusCode,404);
  assert.equal((await request("PUT",pagePath+"/reading",student,{revision:1})).statusCode,409);
  assert.equal((await get(library)).json().resumePageId,null);
  assert.equal((await replace(2,[replacement,page])).statusCode,200);
  assert.equal((await publish(3)).statusCode,200);
  assert.equal((await get(library)).json().resumePageId,page.id);
  const locked={...outline,chapters:[{...outline.chapters[0],lessons:[{...lessonDoc,releaseAt:"2099-01-01T00:00:00Z"}]}]};
  assert.equal((await request("PUT",courseStaff,staff,{revision:1,outline:locked})).statusCode,200);
  assert.equal((await request("POST",courseStaff+"/publish",staff,{revision:2})).statusCode,200);
  assert.equal((await get(pagePath+context)).statusCode,403);
  await owner.query("UPDATE enrollments SET revoked_at=now() WHERE user_id=$1",[student]);
  assert.equal((await get(pagePath)).statusCode,404);
  assert.equal((await get(pagePath+context)).statusCode,404);
  assert.equal((await get(library+"/search?q=cell")).statusCode,404);
});
