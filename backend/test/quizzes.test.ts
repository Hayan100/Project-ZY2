import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { buildApi } from "../src/api.ts";
import { registerRoutes } from "../src/router.ts";

test("lesson quizzes pin revisions, lock tutor answers, preserve omissions and enforce access",
  {skip:!process.env.TEST_DATABASE_URL},async t=>{
  const connectionString=process.env.TEST_DATABASE_URL;
  const owner=new Pool({connectionString});
  const runtime=new Pool({connectionString, options:"-c role=zy2_api"});
  const app=buildApi(async()=>[]);
  t.after(async()=>{await app.close(); await runtime.end(); await owner.end();});
  const staff=randomUUID(), student=randomUUID(), course=randomUUID(), lesson=randomUUID(), quizId=randomUUID();
  const courseKey=randomUUID();
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

  const staffPath="staff/quizzes/"+quizId;
  const a=randomUUID(), b=randomUUID();
  const question={id:randomUUID(),stem:"Which option is correct?",options:[{id:a,text:"One"},{id:b,text:"Two"}],
    correctOptionId:a,explanation:"The first option is correct."};
  const other={...question,id:randomUUID(),stem:"Second question"};
  const quiz={title:"Lesson practice",questions:[question,other]};
  const publish=(revision:number)=>request("POST",staffPath+"/publish",staff,{revision});
  const draft=(revision:number,content:typeof quiz)=>request("PUT",staffPath,staff,{revision,quiz:content});
  const create={id:quizId,quiz};
  assert.equal((await request("POST","staff/quizzes",student,create)).statusCode,403);
  assert.equal((await request("POST","staff/quizzes",staff,create)).statusCode,201);
  assert.equal((await draft(1,{...quiz,questions:[question,question]})).statusCode,400);
  const book=randomUUID(), page=randomUUID();
  const manuscript={title:"Reading",subject:"Biology",exam:"MDCAT",
    pages:[{id:page,title:"First page",blocks:[{type:"paragraph",text:"Reading material."}]}]};
  assert.equal((await request("POST","staff/ebooks",staff,{id:book,manuscript})).statusCode,201);
  assert.equal((await request("POST","staff/ebooks/"+book+"/publish",staff,{revision:1})).statusCode,200);
  const video={id:lesson,title:"Video",type:"video",resourceId:randomUUID(),relatedResourceIds:[quizId,book]};
  const primary={id:randomUUID(),title:"Practice",type:"mcq_quiz",resourceId:quizId};
  const locked={...primary,id:randomUUID(),prerequisiteIds:[video.id]};
  const unrelated={...primary,id:randomUUID(),resourceId:randomUUID()};
  const outline={title:"Intro",chapters:[{id:randomUUID(),title:"Chapter",lessons:[video,primary,locked,unrelated]}]};
  assert.equal((await request("POST","staff/courses",staff,{id:course,productKey:courseKey,outline})).statusCode,201);
  assert.equal((await request("POST","staff/courses/"+course+"/publish",staff,{revision:1})).statusCode,200);
  const lessonPath="courses/"+course+"/lessons/";
  const source=(id:string)=>lessonPath+id+"/quizzes/"+quizId;
  const path=source(lesson);
  const read=(url:string)=>request("GET",url,student);
  const start=(id:string)=>request("POST",path+"/attempts",student,{id});
  const picked=randomUUID(), attempt=path+"/attempts/"+picked;
  const answer=(url:string,id:string,optionId:string)=>request("PUT",url+"/answers/"+id,student,{optionId});
  const submit=(url:string)=>request("POST",url+"/submit",student,{});
  await enroll(courseKey);
  const workspace=lessonPath+lesson+"/workspace";
  assert.deepEqual((await read(workspace)).json().quizzes,[]);
  assert.equal((await read(lessonPath+locked.id+"/workspace")).statusCode,403);
  const context="?courseId="+course+"&lessonId="+lesson;
  assert.equal((await request("PUT","ebooks/"+book+"/pages/"+page+"/reading"+context,student,{revision:1})).statusCode,200);
  assert.equal((await start(picked)).statusCode,404);
  assert.equal((await publish(1)).statusCode,200);
  assert.equal((await read(source(locked.id))).statusCode,403);
  assert.equal((await read(source(unrelated.id))).statusCode,404);
  assert.equal((await request("PUT",lessonPath+lesson+"/progress",student,{revision:1,version:0,position:{videoSeconds:61},completed:false})).statusCode,200);
  assert.equal((await read(path+"/coverage")).json().used,0);
  const starts=await Promise.all([start(picked),start(picked)]);
  for (const res of starts) assert.deepEqual(res.json(),{id:picked,revision:1},res.body);
  assert.equal((await start(randomUUID())).statusCode,409);
  assert.equal((await read(source(primary.id))).json().activeAttemptId,picked);
  const during=(await read(workspace)).json();
  assert.deepEqual(during.quizzes,[{id:quizId,title:quiz.title,activeAttemptId:picked,href:"/api/v1/"+path}]);
  assert.equal(during.books[0].href,"/api/v1/ebooks/"+book+context);
  const before=(await read(attempt)).json();
  for (const q of before.questions) assert.deepEqual(Object.keys(q).sort(),["id","options","stem"]);
  assert.equal((await answer(attempt,question.id,randomUUID())).statusCode,400);
  const changed={...quiz,questions:[{...question,correctOptionId:b,explanation:"Corrected key."},other]};
  assert.equal((await draft(1,changed)).statusCode,200);
  assert.equal((await publish(2)).statusCode,200);
  const responses=await Promise.all([answer(attempt,question.id,a),answer(attempt,question.id,a)]);
  for (const res of responses) assert.equal(res.json().correct,true);
  assert.equal((await answer(attempt,question.id,b)).statusCode,409);
  assert.equal((await read(attempt)).json().questions[1].explanation,undefined);
  assert.equal((await read(path+"/coverage")).json().used,1);
  const result=(await submit(attempt)).json();
  assert.deepEqual([result.correct,result.incorrect,result.omitted,result.total],[1,0,1,2]);
  assert.deepEqual((await submit(attempt)).json(),result);
  const returned=(await read(workspace)).json();
  assert.equal(returned.quizzes[0].activeAttemptId,null);
  assert.equal(returned.position.videoSeconds,61);
  assert.equal(returned.books[0].resumePageId,page);
  assert.equal((await answer(attempt,other.id,a)).statusCode,409);
  assert.equal((await read(attempt)).json().questions[1].selectedOptionId,null);
  assert.equal((await read(path+"/coverage")).json().questions[1].omitted,true);
  const second=randomUUID(), next=path+"/attempts/"+second;
  assert.equal((await start(second)).json().revision,2);
  assert.equal((await answer(next,other.id,b)).json().correct,false);
  assert.equal((await submit(next)).json().omitted,1);
  const coverage=(await read(path+"/coverage")).json();
  assert.equal(coverage.used,2);
  assert.deepEqual(coverage.questions,[{questionId:question.id,correct:true,omitted:true},{questionId:other.id,correct:false,omitted:false}]);
  assert.equal((await read(lessonPath+lesson)).json().position.videoSeconds,61);
  await owner.query("INSERT INTO enrollments(user_id,product_key,starts_at,ends_at) VALUES ($1,$2,now(),now()+interval '1 hour')",[staff,courseKey]);
  assert.equal((await request("GET",attempt,staff)).statusCode,404);
  await owner.query("UPDATE enrollments SET revoked_at=now() WHERE user_id=$1",[student]);
  assert.equal((await read(attempt)).statusCode,404);
  assert.equal((await read(workspace)).statusCode,404);
  assert.equal((await read(path+"/coverage")).statusCode,404);
  const results=(await read("me/quiz-results")).json().results;
  assert.equal(results.length,2);
  assert.deepEqual(Object.keys(results[0]).sort(),["correct","id","incorrect","omitted","quizId","revision","submittedAt","total"].sort());
});
