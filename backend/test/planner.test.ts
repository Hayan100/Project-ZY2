import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { buildApi } from "../src/api.ts";
import { registerCurriculum } from "../src/curriculum.ts";

test("My Camp shares an access-aware planner, consented schedules and canonical progress",
  {skip:!process.env.TEST_DATABASE_URL},async t=>{
  const connectionString=process.env.TEST_DATABASE_URL;
  const owner=new Pool({connectionString});
  const runtime=new Pool({connectionString, options:"-c role=zy2_api"});
  const app=buildApi(async()=>[]);
  t.after(async()=>{await app.close(); await runtime.end(); await owner.end();});
  const staff=randomUUID(), student=randomUUID(), course=randomUUID(), lesson=randomUUID();
  const courseKey=randomUUID();
  for (const id of [staff,student]) {
    await owner.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES ($1,$1,$2,true)',[id,id+"@example.org"]);
    await owner.query(`INSERT INTO session(id,"userId",token,"createdAt","updatedAt","expiresAt")
      VALUES ($1,$1,$1,now(),now(),now()+interval '1 hour')`,[id]);
  }
  await owner.query("INSERT INTO staff_members VALUES ($1)",[staff]);
  await owner.query("INSERT INTO academic_staff VALUES ($1)",[staff]);
  const enroll=(key:string)=>owner.query(`INSERT INTO enrollments(user_id,product_key,starts_at,ends_at)
    VALUES ($1,$2,now(),now()+interval '1 week')`,[student,key]);
  registerCurriculum(app,runtime,async cookie=>cookie?{user:{id:cookie,emailVerified:true},session:{id:cookie}}:null,"http://localhost");
  const request=(method:"GET"|"POST"|"PUT"|"PATCH",path:string,cookie:string,payload?:object)=>
    app.inject({method,url:"/api/v1/"+path,headers:{cookie},payload});

  const base="me/planner";
  const get=(url:string,cookie=student)=>request("GET",url,cookie);
  const future=new Date(Date.now()+48*3600000).toISOString().slice(0,10);
  const later=new Date(Date.now()+96*3600000).toISOString().slice(0,10);
  const at=(time:string)=>future+"T"+time+":00+05:00";
  const outline={title:"Camp course",exam:"MDCAT",chapters:[{id:randomUUID(),title:"Chapter",lessons:[
    {id:lesson,title:"Available",estimatedMinutes:30,type:"video",resourceId:randomUUID()},
    {id:randomUUID(),title:"Locked",estimatedMinutes:30,type:"video",resourceId:randomUUID(),prerequisiteIds:[lesson]}]}]};
  assert.equal((await request("POST","staff/courses",staff,{id:course,productKey:courseKey,outline})).statusCode,201);
  assert.equal((await request("POST","staff/courses/"+course+"/publish",staff,{revision:1})).statusCode,200);
  await enroll(courseKey);
  const batch=randomUUID(),offer=randomUUID(),invoice=randomUUID(),event=randomUUID();
  await owner.query("INSERT INTO admission_batches(id,capacity) VALUES($1,10)",[batch]);
  await owner.query(`INSERT INTO payment_offers(id,product_key,amount_paisa,receiving_account,instructions,policy_version,policy_text,support_contact,
    review_hours,starts_at,ends_at,batch_id) VALUES($1,$2,100,'a','b','1','terms','contact',1,now(),now()+interval '3 days',$3)`,[offer,courseKey,batch]);
  await owner.query("INSERT INTO payment_invoices(id,student_id,created_by,offer_id) VALUES($1,$2,$2,$3)",[invoice,student,offer]);
  await owner.query("INSERT INTO payment_proofs(invoice_id,revision,submitted_by,screenshot) VALUES($1,1,$2,$3)",[invoice,student,Buffer.alloc(1024)]);
  const fixture=await owner.connect();
  try {
    await fixture.query("BEGIN");
    await fixture.query(`INSERT INTO payment_receipts(invoice_id,revision,enrollment_id,verified_by,verified_at,transferred_at,receiving_account,
    transfer_reference,extra_seat,amount_paisa) SELECT $1,1,id,$2,now(),now(),'a',$1::uuid::text,false,100 FROM enrollments WHERE user_id=$3 AND product_key=$4`,[invoice,staff,student,courseKey]);
    // Keep this batch fixture outside the receipt worker's pending deliveries.
    await fixture.query("UPDATE payment_messages SET accepted_at=now() WHERE invoice_id=$1",[invoice]);
    await fixture.query("COMMIT");
  } catch(error) {await fixture.query("ROLLBACK"); throw error;} finally {fixture.release();}
  const eventPath="staff/planner/events/"+event;
  const update={batchId:batch,kind:"mock",revision:0,title:"Mock",startsAt:at("09:00"),minutes:60};
  assert.equal((await request("POST",eventPath+"/preview",student,update)).statusCode,403);
  const preview=await request("POST",eventPath+"/preview",staff,update);
  assert.equal(preview.statusCode,200,preview.body);
  assert.equal(preview.json().students,1);
  const publish=(token:string)=>request("POST",eventPath+"/publish",staff,{...update,token});
  assert.equal((await publish("0".repeat(64))).statusCode,409);
  assert.equal((await publish(preview.json().token)).statusCode,200);
  const own={id:randomUUID(),title:"Past task",startsAt:new Date(Date.now()-86400000).toISOString(),minutes:20};
  assert.equal((await request("POST",base+"/tasks",student,own)).statusCode,200);
  assert.equal((await request("POST",base+"/tasks",student,{...own,id:randomUUID(),startsAt:at("09:30")})).statusCode,409);
  const fixed={id:randomUUID(),title:"Mentor review",fixed:true,minutes:20,startsAt:at("10:00")};
  const m="mentor/students/"+student+"/planner/tasks/";
  assert.equal((await request("POST",m+"preview",staff,fixed)).statusCode,403);
  await owner.query("INSERT INTO revision_mentors(student_id,mentor_id) VALUES($1,$2)",[student,staff]);
  const fp=await request("POST",m+"preview",staff,fixed);
  assert.equal(fp.statusCode,200,fp.body);
  assert.equal((await request("POST",m+"publish",staff,{...fixed,token:fp.json().token})).statusCode,200);
  assert.equal((await request("PATCH",base+"/tasks/"+fixed.id,student,{version:1,startsAt:at("11:00")})).statusCode,409);
  assert.equal((await request("POST",base+"/fixed/"+fixed.id+"/change-request",student,{startsAt:at("11:00")})).statusCode,200);
  const p={mode:"initial",startDate:future,targetDate:later,targetExam:"MDCAT",preparation:"starting",
    weekdays:[1,2,3,4,5,6,7],startMinute:540,minutesPerDay:120};
  const suggest=(mode:string)=>request("POST",base+"/suggestions/preview",student,{profile:{...p,mode}});
  const accept=(token:string,mode:string)=>request("POST",base+"/suggestions/accept",student,{profile:{...p,mode},token});
  const first=await suggest("initial");
  assert.equal(first.statusCode,200,first.body);
  assert.equal(first.json().moves.length,1);
  assert.equal(first.json().moves[0].startsAt,new Date(at("10:20")).toISOString());
  const before=await get(base+"?date="+future);
  assert.equal(before.json().tasks.length,1);
  assert.equal(before.json().events[0].id,event);
  assert.equal((await get(base+"?date="+future,staff)).json().events.length,0);
  assert.equal((await accept(first.json().token,"initial")).statusCode,200);
  assert.equal((await accept(first.json().token,"initial")).statusCode,200);
  const catchup=(await suggest("catch_up")).json();
  assert.equal(catchup.moves[0].taskId,own.id);
  assert.equal((await request("PATCH",base+"/tasks/"+own.id,student,{version:1,completed:false})).statusCode,200);
  assert.equal((await accept(catchup.token,"catch_up")).statusCode,409);
  const newer=(await suggest("catch_up")).json();
  assert.equal((await accept(newer.token,"catch_up")).statusCode,200);
  const notices=(await get("me/planner-notices",staff)).json().notices;
  assert.ok(notices.some((n:{kind:string})=>n.kind==="student_rescheduled"));
  assert.equal((await request("PATCH",base+"/tasks/"+own.id,staff,{version:3,completed:true})).statusCode,404);
  assert.equal((await request("PATCH",base+"/tasks/"+own.id,student,{version:3,completed:true})).statusCode,200);
  const camp=await get("me/camp");
  assert.equal(camp.statusCode,200,camp.body);
  assert.equal(camp.json().continueLesson.lessonId,lesson);
  assert.equal(camp.json().upcomingEvents[0].id,event);
  assert.equal(camp.json().revision.due,(await get("me/revision")).json().dueCount);
  const progress=await get("me/progress?download=true&from="+future+"&to="+later);
  assert.equal(progress.statusCode,200,progress.body);
  assert.equal(progress.json().studyPlan.completed,1);
  assert.equal(progress.json().studyPlan.total,3);
  assert.equal(progress.json().quiz.accuracy,null);
  assert.match(progress.headers["content-disposition"] as string,/attachment/);
  const month=await get(base+"?view=month&date="+future+"&download=true");
  assert.match(month.headers["content-disposition"] as string,/attachment/);
  assert.ok(month.json().events.some((e:{id:string})=>e.id===event));
  const quiz=randomUUID(),questionId=randomUUID(),optionId=randomUUID(),attempt=randomUUID(),book=randomUUID(),page=randomUUID();
  const questions=[{id:questionId,stem:"First",options:[{id:optionId,text:"Yes"},{id:randomUUID(),text:"No"}],correctOptionId:optionId,explanation:"Review"},
    {id:randomUUID(),stem:"Second",options:[{id:optionId,text:"Yes"},{id:randomUUID(),text:"No"}],correctOptionId:optionId,explanation:"Review"}];
  assert.equal((await request("POST","staff/quizzes",staff,{id:quiz,quiz:{title:"Practice",questions}})).statusCode,201);
  assert.equal((await request("POST","staff/quizzes/"+quiz+"/publish",staff,{revision:1})).statusCode,200);
  assert.equal((await request("POST","staff/ebooks",staff,{id:book,manuscript:{title:"Reader",subject:"Biology",exam:"MDCAT",
    pages:[{id:page,title:"Reading",blocks:[{type:"paragraph",text:"Sample content"}]}]}})).statusCode,201);
  assert.equal((await request("POST","staff/ebooks/"+book+"/publish",staff,{revision:1})).statusCode,200);
  const chapter=outline.chapters[0];
  const linked={...outline,chapters:[{...chapter,lessons:[{...chapter.lessons[0],relatedResourceIds:[quiz,book]},chapter.lessons[1]]}]};
  assert.equal((await request("PUT","staff/courses/"+course,staff,{revision:1,outline:linked})).statusCode,200);
  assert.equal((await request("POST","staff/courses/"+course+"/publish",staff,{revision:2})).statusCode,200);
  const src="courses/"+course+"/lessons/"+lesson+"/quizzes/"+quiz+"/attempts";
  assert.equal((await request("POST",src,student,{id:attempt})).statusCode,200);
  assert.equal((await request("PUT",src+"/"+attempt+"/answers/"+questionId,student,{optionId})).statusCode,200);
  assert.equal((await request("POST",src+"/"+attempt+"/submit",student,{})).statusCode,200);
  assert.equal((await request("PUT","ebooks/"+book+"/pages/"+page+"/reading?courseId="+course+"&lessonId="+lesson,student,{revision:1,studied:true})).statusCode,200);
  assert.equal((await get("me/camp")).json().continueReading.pageId,page);
  const populated=(await get("me/progress")).json();
  assert.deepEqual(populated.currentCoverage.lessonQuizzes,{eligible:2,used:1});
  assert.deepEqual(populated.currentCoverage.reading,{visitedPages:1,studiedPages:1});
  assert.equal(populated.quiz.correct,1);
  assert.equal(populated.quiz.omitted,1);
  assert.equal(populated.quiz.accuracy,1);
  assert.equal((await get("me/progress?from="+later)).json().quiz.uniqueAnswered,0);
  await owner.query("UPDATE enrollments SET revoked_at=now() WHERE user_id=$1",[student]);
  const after=(await get("me/camp")).json();
  assert.equal(after.continueLesson,null);
  assert.equal(after.continueReading,null);
  const historical=(await get("me/progress")).json();
  assert.deepEqual(historical.currentCoverage.lessonQuizzes,{eligible:0,used:0});
  assert.equal(historical.quiz.correct,1);
  assert.deepEqual(after.upcomingEvents,[]);
  const remaining=(await get(base+"?date="+future)).json().tasks;
  assert.ok(remaining.some((t:{title:string;lessonUrl:string|null})=>t.title==="Study task" && t.lessonUrl===null));
});
