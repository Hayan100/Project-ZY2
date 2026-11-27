import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { buildApi } from "../src/api.ts";
import { registerRoutes } from "../src/router.ts";

test("lesson flashcards activate explicitly, share FSRS schedules and retain review history",
  {skip:!process.env.TEST_DATABASE_URL},async t=>{
  const connectionString=process.env.TEST_DATABASE_URL;
  const owner=new Pool({connectionString});
  const runtime=new Pool({connectionString, options:"-c role=zy2_api"});
  const app=buildApi(async()=>[]);
  t.after(async()=>{await app.close(); await runtime.end(); await owner.end();});
  const staff=randomUUID(), student=randomUUID(), course=randomUUID(), lesson=randomUUID(), deckId=randomUUID();
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

  const first={id:randomUUID(),front:"What is ATP?",back:"Adenosine triphosphate"};
  const second={id:randomUUID(),front:"What is ADP?",back:"Adenosine diphosphate"};
  const shared=randomUUID(), locked=randomUUID();
  const edit=(id:string,revision:number,cards:object[],actor=staff)=>request("PUT","staff/decks/"+id,actor,{revision,deck:{title:"Biology",cards}});
  const publish=(id:string,revision:number,resetCardIds:string[]=[])=>request("POST","staff/decks/"+id+"/publish",staff,{revision,resetCardIds});
  const get=(path:string)=>request("GET",path,student);
  const rev="me/revision";
  const queue=async()=>{
    const res=await get(rev);
    assert.equal(res.statusCode,200,res.body);
    return res.json();
  };
  const source=(id:string,l=lesson)=>"courses/"+course+"/lessons/"+l+"/decks/"+id;
  const savedVideo={id:lesson,title:"Lecture",type:"video",resourceId:randomUUID(),relatedResourceIds:[deckId,shared]};
  const outline={title:"Course",chapters:[{id:randomUUID(),title:"Chapter",lessons:[savedVideo,
    {id:locked,title:"Cards",type:"flashcard_review",resourceId:deckId,releaseAt:"2099-01-01T00:00:00Z"}]}]};
  assert.equal((await edit(deckId,0,[first,second],student)).statusCode,403);
  assert.equal((await edit(deckId,0,[first,second])).statusCode,200);
  assert.equal((await request("POST","staff/courses",staff,{id:course,productKey:courseKey,outline})).statusCode,201);
  assert.equal((await request("POST","staff/courses/"+course+"/publish",staff,{revision:1})).statusCode,200);
  await enroll(courseKey);
  assert.equal((await get(source(deckId))).statusCode,404);
  const published=await publish(deckId,1);
  assert.equal(published.statusCode,200,published.body);
  assert.equal((await edit(shared,0,[{id:first.id}])).statusCode,200);
  assert.equal((await publish(shared,1)).statusCode,200);
  assert.equal((await get(source(deckId,locked))).statusCode,403);
  assert.equal((await request("PUT","courses/"+course+"/lessons/"+lesson+"/progress",student,{
    revision:1,version:0,completed:true,position:{videoSeconds:62}})).statusCode,200);
  assert.equal((await queue()).decks.length,2);
  const home=async()=>(await get(rev+"/home")).json();
  const suggested=await home();
  assert.equal(suggested.startReview,null);
  assert.deepEqual(suggested.myDecks,[]);
  assert.equal(suggested.recommendedDecks.length,2);
  assert.ok(suggested.recommendedDecks.some((d:{actionHref:string})=>d.actionHref==="/api/v1/"+source(deckId)+"/activation"));
  assert.deepEqual((await queue()).cards,[]);
  assert.equal((await get(source(deckId)+"/review")).statusCode,409);
  assert.equal((await request("POST",source(shared)+"/assign",staff,{studentId:student})).statusCode,403);
  await owner.query("INSERT INTO revision_mentors(student_id,mentor_id) VALUES($1,$2)",[student,staff]);
  assert.equal((await request("POST",source(shared)+"/assign",staff,{studentId:student})).statusCode,200);
  assert.equal((await request("PUT",source(deckId)+"/activation",student)).statusCode,200);
  assert.equal((await request("PUT",source(deckId)+"/activation",student)).statusCode,200);
  assert.equal((await queue()).newCount,0);
  assert.equal((await request("PUT","mentor/students/"+student+"/revision-budget",staff,{minutes:5})).statusCode,200);
  assert.deepEqual((await queue()).suggestedMinutes,[5]);
  assert.equal((await request("PUT",rev+"/budget",student,{minutes:1})).statusCode,200);
  const initial=await queue();
  assert.equal(initial.newRemaining,2);
  assert.equal(initial.newCount,1);
  const c=initial.cards[0];
  const ready=await home();
  assert.equal(ready.myDecks.length,2);
  assert.deepEqual(ready.recommendedDecks,[]);
  assert.equal(ready.dueToday,0);
  assert.equal(ready.startReview.front,c.front);
  assert.equal(ready.startReview.back,undefined);
  assert.equal((await get(ready.startReview.revealHref.slice("/api/v1/".length))).json().back,first.back);
  assert.equal(c.cardId,first.id);
  assert.equal((await get(source(shared)+"/review")).json().cards[0].deckId,shared);
  assert.equal(c.back,undefined);
  const cardPath=(d:string)=>rev+"/decks/"+d+"/cards/"+first.id;
  assert.equal((await get(cardPath(c.deckId))).json().back,first.back);
  const review={eventId:randomUUID(),revision:c.revision,cardRevision:c.cardRevision,version:0,rating:"Easy"};
  const send=(d:string,body:object)=>request("PUT",cardPath(d)+"/review",student,body);
  const attempts=await Promise.all([send(c.deckId,review),send(c.deckId,review)]);
  for (const res of attempts) assert.equal(res.statusCode,200,res.body);
  assert.deepEqual(attempts[0].json(),attempts[1].json());
  assert.equal((await send(c.deckId,{...review,rating:"Again"})).statusCode,409);
  const after=await queue();
  assert.equal(after.cards.length,0);
  assert.equal(Object.values(after.forecast)[0],1);
  const changed={...first,front:"Expanded front"};
  assert.equal((await edit(deckId,1,[changed,second])).statusCode,200);
  assert.equal((await publish(deckId,2)).statusCode,200);
  assert.deepEqual((await queue()).forecast,after.forecast);
  assert.equal((await edit(deckId,2,[changed,second])).statusCode,200);
  assert.equal((await publish(deckId,3,[first.id])).statusCode,200);
  const reset=await queue();
  assert.equal(reset.dueCount,1);
  assert.equal(reset.cards[0].front,changed.front);
  assert.equal(reset.cards[0].cardRevision,3);
  const {deckId:sourceDeck,revision,cardRevision,version}=reset.cards[0];
  assert.equal((await send(sourceDeck,{...review,eventId:randomUUID()})).statusCode,409);
  assert.equal((await send(sourceDeck,{eventId:randomUUID(),revision,cardRevision,version,rating:"Again"})).statusCode,200);
  // Move only the eligibility clock forward to exercise scheduling from persisted FSRS state.
  await owner.query("UPDATE card_reviews SET due_at=now()-interval '1 day' WHERE student_id=$1 AND version=2",[student]);
  const overdue=await queue();
  assert.equal(overdue.dueCount,1);
  assert.equal((await home()).dueToday,1);
  assert.equal(overdue.newCount,0);
  assert.equal((await send(sourceDeck,{eventId:randomUUID(),revision,cardRevision,version:2,rating:"Hard"})).statusCode,200);
  await owner.query("UPDATE card_reviews SET due_at=now()-interval '1 day' WHERE student_id=$1 AND version=3",[student]);
  assert.equal((await send(sourceDeck,{eventId:randomUUID(),revision,cardRevision,version:3,rating:"Good"})).statusCode,200);
  assert.equal((await get(rev+"/history")).json().reviews.length,4);
  assert.deepEqual((await get("courses/"+course+"/lessons/"+lesson)).json().position,{videoSeconds:62});
  await owner.query("UPDATE enrollments SET revoked_at=now() WHERE user_id=$1",[student]);
  assert.equal((await get(source(deckId))).statusCode,404);
  assert.equal((await queue()).decks.length,0);
  assert.deepEqual((await home()).myDecks,[]);
  assert.equal((await home()).startReview,null);
  const personal=rev+"/personal",newCard={id:randomUUID(),front:"My prompt",back:"My answer"};
  const created=(await request("POST",personal,student,newCard)).json();
  assert.deepEqual((await request("POST",personal,student,newCard)).json(),created);
  assert.equal((await request("PUT",personal+"/"+created.id,student,{revision:1,front:"Revised",back:newCard.back})).json().revision,2);
  assert.equal((await get(personal+"/"+created.id+"/history")).json().versions.length,2);
  assert.deepEqual((await request("GET",personal,staff)).json().cards,[]);
  assert.equal((await request("PUT",rev+"/budget",student,{minutes:60})).statusCode,200);
  const mine=(await home()).startReview;
  const reveal=(await get(mine.revealHref.slice(8))).json();
  assert.equal(reveal.front,"Revised");
  assert.equal((await request("PUT",mine.rateHref.slice(8),student,{eventId:randomUUID(),version:0,
    revision:reveal.revision,cardRevision:reveal.cardRevision,rating:"Good"})).statusCode,200);
  assert.equal((await send(c.deckId,review)).statusCode,404);
  assert.equal((await get(rev+"/history")).json().reviews.length,5);
});
