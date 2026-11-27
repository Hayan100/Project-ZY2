import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { createEmptyCard, fsrs, Rating, type CardInput } from "ts-fsrs";
import { fail, type Academic, type sessionTransaction } from "./authorized.ts";
import { courseLessons, loadCourse } from "./learning.ts";
import type { Lesson, Outline } from "./curriculum.ts";

type CardText = { id:string; front?:string; back?:string };
type Deck = { title:string; cards:CardText[] };
type Published = { deck_id:string; revision:number; deck:Deck; active:boolean };
type Link = { courseId:string; lessonId:string; deckId:string };
type Saved = { card_id:string; version:number; card_revision:number; due_at:Date; schedule:CardInput };
type Grade = "Again"|"Hard"|"Good"|"Easy";
const scheduler=fsrs({request_retention:0.9,enable_fuzz:false});
const uuid={type:"string",format:"uuid",pattern:"^[0-9a-f-]+$"};
const version={type:"integer",minimum:0,maximum:2147483646};
const revision={...version,minimum:1};
const textField=(maxLength:number)=>({type:"string",maxLength,pattern:"\\S"});
const object=(properties:Record<string,object>,required=Object.keys(properties))=>({type:"object",properties,required,additionalProperties:false});
const deckSchema=object({title:textField(200),cards:{type:"array",maxItems:500,items:{...object({id:uuid,front:textField(4000),back:textField(8000)},["id"]),dependencies:{front:["back"],back:["front"]}}}});
const linkParams=object({courseId:uuid,lessonId:uuid,deckId:uuid});
const deckParams=object({id:uuid});
const dailyZone="Asia/Karachi";
const dayFormat=new Intl.DateTimeFormat("en-CA",{timeZone:dailyZone,year:"numeric",month:"2-digit",day:"2-digit"});
const reviewSeconds=30, newSeconds=60;
function links(l:Lesson) {
  return [...(l.type==="flashcard_review" && l.resourceId?[l.resourceId]:[]),...(l.relatedResourceIds ?? [])];
}
function lock(tx:PoolClient,id:string,namespace:number) {
  return tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,$2))",[id,namespace]);
}

export function registerFlashcards(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>,academic:Academic,accessible:string) {
  const staff="/api/v1/staff/decks", revisionPath="/api/v1/me/revision";
  const source="/api/v1/courses/:courseId/lessons/:lessonId/decks/:deckId";
  app.get(staff,req=>academic(req,async tx=>({decks:(await tx.query(`SELECT DISTINCT ON(deck_id) deck_id AS id,revision,
    deck->>'title' AS title,max(revision) FILTER(WHERE published_at IS NOT NULL) OVER(PARTITION BY deck_id) AS "publishedRevision"
    FROM deck_revisions ORDER BY deck_id,revision DESC`)).rows})));
  app.get<{Params:{id:string};Querystring:{revision?:number}}>(staff+"/:id",{schema:{params:deckParams,querystring:object({revision},[])}},
    req=>academic(req,async tx=>(await tx.query(`SELECT deck_id AS id,revision,deck,authored_by AS "authoredBy",
      published_by AS "publishedBy",reset_cards AS "resetCardIds" FROM deck_revisions WHERE deck_id=$1
      AND ($2::int IS NULL OR revision=$2) ORDER BY revision DESC LIMIT 1`,[req.params.id,req.query.revision])).rows[0] ?? fail(404)));
  app.put<{Params:{id:string};Body:{revision:number;deck:Deck}}>(staff+"/:id",{bodyLimit:2*1024*1024,
    schema:{params:deckParams,body:object({revision:version,deck:deckSchema})}},req=>academic(req,async(tx,user)=>{
    const {deck,revision:base}=req.body;
    if (new Set(deck.cards.map(c=>c.id)).size!==deck.cards.length) fail(400);
    await lock(tx,req.params.id,9);
    const latest=await tx.query("SELECT max(revision) AS revision FROM deck_revisions WHERE deck_id=$1",[req.params.id]);
    if ((latest.rows[0].revision ?? 0)!==base) fail(409);
    await tx.query("INSERT INTO deck_revisions(deck_id,revision,deck,authored_by) VALUES($1,$2,$3,$4)",[req.params.id,base+1,deck,user]);
    return {id:req.params.id,revision:base+1};
  }));
  app.post<{Params:{id:string};Body:{revision:number;resetCardIds?:string[]}}>(staff+"/:id/publish",{
    schema:{params:deckParams,body:object({revision,resetCardIds:{type:"array",items:uuid,maxItems:500,uniqueItems:true}},["revision"])}
  },req=>academic(req,async(tx,user)=>{
    const {id}=req.params, {revision}=req.body;
    const resets=(req.body.resetCardIds ?? []).sort();
    await lock(tx,id,9);
    const row=(await tx.query("SELECT revision,deck,published_at,reset_cards FROM deck_revisions WHERE deck_id=$1 ORDER BY revision DESC LIMIT 1",[id])).rows[0] ?? fail(404);
    if (row.revision!==revision) fail(409);
    if (row.published_at) {
      if (resets.join()!==row.reset_cards.join()) fail(409);
    } else {
      const ids=new Set((row.deck as Deck).cards.map(c=>c.id));
      if (!ids.size || resets.some(id=>!ids.has(id))) fail(422);
      const cards=(row.deck as Deck).cards;
      const authored=cards.filter(c=>c.front!==undefined);
      if (resets.some(id=>!authored.some(c=>c.id===id))) fail(422);
      const stored=await tx.query(`INSERT INTO academy_cards(card_id,owner_deck,revision,front,back,reset_revision)
        SELECT c.id,$1,$2,c.front,c.back,CASE WHEN c.id=ANY($4::uuid[]) THEN $2 ELSE 0 END
        FROM jsonb_to_recordset($3::jsonb) AS c(id uuid,front text,back text) ORDER BY c.id
        ON CONFLICT(card_id) DO UPDATE SET front=excluded.front,back=excluded.back,
          revision=CASE WHEN (academy_cards.front,academy_cards.back) IS DISTINCT FROM (excluded.front,excluded.back)
            OR excluded.reset_revision>0 THEN excluded.revision ELSE academy_cards.revision END,
          reset_revision=greatest(academy_cards.reset_revision,excluded.reset_revision)
        WHERE academy_cards.owner_deck=excluded.owner_deck`,[id,revision,JSON.stringify(authored),resets]);
      if (stored.rowCount!==authored.length) fail(409);
      const found=await tx.query("SELECT card_id FROM academy_cards WHERE card_id=ANY($1::uuid[])",[[...ids]]);
      if (found.rowCount!==ids.size) fail(422);
      await tx.query("UPDATE deck_revisions SET published_at=now(),published_by=$3,reset_cards=$4 WHERE deck_id=$1 AND revision=$2",[id,revision,user,resets]);
    }
    return {id,publishedRevision:revision,resetCardIds:resets};
  }));
  async function lessonDeck(tx:PoolClient,student:string,path:Link,write:boolean) {
    const course=await loadCourse(tx,accessible,student,path.courseId,write);
    if (!links(course.available(path.lessonId)).includes(path.deckId)) fail(404);
    return (await tx.query<Published>(`SELECT d.*,EXISTS(SELECT FROM deck_activations WHERE student_id=$1 AND deck_id=d.deck_id) AS active
      FROM published_decks d WHERE deck_id=$2`,[student,path.deckId])).rows[0] ?? fail(404);
  }
  app.get<{Params:Link}>(source,{schema:{params:linkParams}},req=>session(req,async(tx,actor)=>{
    const row=await lessonDeck(tx,actor.id,req.params,false);
    return {id:row.deck_id,revision:row.revision,title:row.deck.title,count:row.deck.cards.length,active:row.active};
  }));
  async function activate(tx:PoolClient,student:string,path:Link,actor:string) {
    const row=await lessonDeck(tx,student,path,true);
    await tx.query(`INSERT INTO deck_activations(student_id,deck_id,revision,activated_by) VALUES ($1,$2,$3,$4)
      ON CONFLICT DO NOTHING`,[student,row.deck_id,row.revision,actor]);
    return {deckId:row.deck_id,active:true};
  }
  app.put<{Params:Link}>(source+"/activation",{schema:{params:linkParams}},req=>session(req,(tx,actor)=>activate(tx,actor.id,req.params,actor.id)));
  app.post<{Params:Link;Body:{studentId:string}}>(source+"/assign",{schema:{params:linkParams,body:object({studentId:textField(200)})}},
    req=>session(req,async(tx,actor)=>{
      const student=req.body.studentId;
      if (!(await tx.query("SELECT FROM revision_mentors WHERE student_id=$1 AND mentor_id=$2",[student,actor.id])).rowCount) fail(403);
      return activate(tx,student,req.params,actor.id);
    }));
  app.put<{Body:{minutes:number}}>(revisionPath+"/budget",{schema:{body:object({minutes:{type:"integer",minimum:1,maximum:1440}})}},
    req=>session(req,async(tx,actor)=>{
      await lock(tx,actor.id,10);
      await tx.query(`INSERT INTO revision_budgets(student_id,minutes) VALUES($1,$2)
        ON CONFLICT(student_id) DO UPDATE SET minutes=excluded.minutes`,[actor.id,req.body.minutes]);
      return {minutes:req.body.minutes};
    }));

  app.put<{Params:{studentId:string};Body:{minutes:number}}>("/api/v1/mentor/students/:studentId/revision-budget",{
    schema:{params:object({studentId:textField(200)}),body:object({minutes:{type:"integer",minimum:1,maximum:1440}})}
  },req=>session(req,async(tx,actor)=>{
    const result=await tx.query("UPDATE revision_mentors SET suggested_minutes=$3 WHERE student_id=$1 AND mentor_id=$2",
      [req.params.studentId,actor.id,req.body.minutes]);
    if (!result.rowCount) fail(403);
    return {suggestedMinutes:req.body.minutes};
  }));
  app.get(revisionPath+"/history",req=>session(req,async(tx,actor)=>({reviews:(await tx.query(`SELECT event_id AS "eventId",
    deck_id AS "deckId",card_id AS "cardId",revision,card_revision AS "cardRevision",version,rating,reviewed_at AS "reviewedAt",due_at AS "dueAt"
    FROM card_reviews WHERE student_id=$1 ORDER BY reviewed_at DESC,event_id DESC LIMIT 100`,[actor.id])).rows})));

  async function queue(tx:PoolClient,student:string) {
    const settings=(await tx.query(`SELECT clock_timestamp() AS now, ARRAY(SELECT suggested_minutes FROM revision_mentors WHERE student_id=$1 AND suggested_minutes IS NOT NULL ORDER BY mentor_id) AS suggestions,(SELECT minutes FROM revision_budgets WHERE student_id=$1) AS minutes,
      (SELECT coalesce(sum(CASE WHEN introduced THEN $3::int ELSE $4::int END),0)::int FROM card_reviews WHERE student_id=$1
       AND reviewed_at >= (date_trunc('day',clock_timestamp() AT TIME ZONE $2) AT TIME ZONE $2)) AS spent`,
      [student,dailyZone,newSeconds,reviewSeconds])).rows[0];
    const now:Date=settings.now;
    const courses=await tx.query(`SELECT c.id,r.outline,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('lesson_id',p.lesson_id,'resource_id',p.resource_id,'lesson_type',p.lesson_type,'completed',true)),'[]')
       FROM lesson_progress p WHERE p.user_id=$1 AND p.course_id=c.id AND completed) AS completed ${accessible} ORDER BY c.id`,[student]);
    const sources=new Map<string,{courseId:string;lessonId:string}>();
    for (const course of courses.rows) {
      const state=courseLessons(course.outline as Outline,now,course.completed);
      for (const lesson of state.lessons) if (!state.lockReason(lesson)) {
        for (const id of links(lesson)) if (!sources.has(id)) sources.set(id,{courseId:course.id,lessonId:lesson.id});
      }
    }
    const ids=[...sources.keys()];
    const decks=(await tx.query<Published>(`SELECT d.*,a.deck_id IS NOT NULL AS active FROM published_decks d
      LEFT JOIN deck_activations a ON a.deck_id=d.deck_id AND a.student_id=$1 WHERE d.deck_id=ANY($2::uuid[]) ORDER BY d.deck_id`,[student,ids])).rows;
    const cardIds=[...new Set(decks.filter(d=>d.active).flatMap(d=>d.deck.cards.map(c=>c.id)))];
    const saved=await tx.query<Saved>(`SELECT DISTINCT ON(card_id) card_id,card_revision,version,schedule,due_at
      FROM card_reviews WHERE student_id=$1 AND card_id=ANY($2::uuid[]) ORDER BY card_id,version DESC`,[student,cardIds]);
    const schedules=new Map(saved.rows.map(c=>[c.card_id,c]));
    const content=await tx.query("SELECT * FROM academy_cards WHERE card_id=ANY($1::uuid[])",[cardIds]);
    const canonical=new Map(content.rows.map(c=>[c.card_id,c]));
    const seen=new Set<string>();
    type Item={deckId:string;cardId:string;revision:number;cardRevision:number;version:number;front:string;back:string;dueAt:Date|null;reset:boolean};
    const due:Item[]=[], fresh:Item[]=[];
    const forecast=new Map<string,number>();
    for (const row of decks.filter(d=>d.active)) for (const card of row.deck.cards) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      const text=canonical.get(card.id), prior=schedules.get(card.id);
      const reset=!!prior && prior.card_revision<text.reset_revision;
      const dueAt=reset?now:(prior?.due_at ?? null);
      const item={deckId:row.deck_id,cardId:card.id,revision:row.revision,version:prior?.version ?? 0,cardRevision:text.revision,front:text.front,back:text.back,dueAt,reset};
      if (!dueAt) fresh.push(item);
      else if (dueAt<=now) due.push(item);
      else {
        const day=dayFormat.format(dueAt);
        forecast.set(day,(forecast.get(day) ?? 0)+1);
      }
    }
    due.sort((a,b)=>a.dueAt!.getTime()-b.dueAt!.getTime());
    const slots=Math.max(0,Math.floor(((settings.minutes ?? 0)*60-settings.spent-due.length*reviewSeconds)/newSeconds));
    const cards=[...due,...fresh.slice(0,slots)];
    function cardsFor(deckId:string) {
      const deck=decks.find(d=>d.deck_id===deckId && d.active);
      if (!deck) return [];
      const members=new Set(deck.deck.cards.map(c=>c.id));
      return cards.filter(c=>members.has(c.cardId)).map(c=>({...c,deckId,revision:deck.revision}));
    }
    return {now,schedules,cards,cardsFor,summary:{minutes:settings.minutes,suggestedMinutes:settings.suggestions,spentSeconds:settings.spent,dueCount:due.length,
      newCount:Math.min(slots,fresh.length),newRemaining:fresh.length,forecast:Object.fromEntries([...forecast].sort()),
      decks:decks.map(d=>({deckId:d.deck_id,title:d.deck.title,active:d.active,...sources.get(d.deck_id)}))}};
  }
  app.get(revisionPath,req=>session(req,async(tx,actor)=>{
    const {summary,cards}=await queue(tx,actor.id);
    return {...summary,cards:cards.map(({back,reset,...card})=>card)};
  }));
  app.get<{Params:Link}>(source+"/review",{schema:{params:linkParams}},req=>session(req,async(tx,actor)=>{
    const deck=await lessonDeck(tx,actor.id,req.params,false);
    if (!deck.active) fail(409);
    const state=await queue(tx,actor.id);
    return {deckId:deck.deck_id,cards:state.cardsFor(deck.deck_id).map(({back,reset,...card})=>card)};
  }));
  const cardPath=revisionPath+"/decks/:deckId/cards/:cardId";
  type CardPath={deckId:string;cardId:string};
  const params=object({deckId:uuid,cardId:uuid});
  app.get<{Params:CardPath}>(cardPath,{schema:{params}},req=>session(req,async(tx,actor)=>{
    const state=await queue(tx,actor.id);
    const item=state.cardsFor(req.params.deckId).find(c=>c.cardId===req.params.cardId) ?? fail(404);
    return {front:item.front,back:item.back,revision:item.revision,cardRevision:item.cardRevision,version:item.version};
  }));
  app.put<{Params:CardPath;Body:{eventId:string;revision:number;cardRevision:number;version:number;rating:Grade}}>(cardPath+"/review",{
    schema:{params,body:object({eventId:uuid,revision,cardRevision:revision,version,rating:{enum:["Again","Hard","Good","Easy"]}})}
  },req=>session(req,async(tx,actor)=>{
    const {deckId,cardId}=req.params;
    const {eventId,revision,cardRevision,version,rating}=req.body;
    await lock(tx,actor.id,10);
    await lock(tx,deckId,9);
    await tx.query("SELECT card_id FROM academy_cards WHERE card_id=$1 FOR SHARE",[cardId]);
    const state=await queue(tx,actor.id);
    if (!state.summary.decks.some(d=>d.deckId===deckId && d.active)) fail(404);
    const replay=(await tx.query("SELECT * FROM card_reviews WHERE student_id=$1 AND event_id=$2",[actor.id,eventId])).rows[0];
    if (replay) {
      if (replay.deck_id!==deckId || replay.card_id!==cardId || replay.version!==version+1 || replay.revision!==revision || replay.card_revision!==cardRevision || replay.rating!==rating) fail(409);
      return {eventId,version:replay.version,dueAt:replay.due_at};
    }
    const card=state.cardsFor(deckId).find(c=>c.cardId===cardId);
    if (!card || card.revision!==revision || card.cardRevision!==cardRevision || card.version!==version || (!version && state.summary.dueCount)) fail(409);
    const prior=state.schedules.get(cardId);
    const before=prior && !card.reset ? prior.schedule : createEmptyCard(state.now);
    const next=scheduler.next(before,state.now,Rating[rating]).card;
    await tx.query(`INSERT INTO card_reviews(student_id,event_id,deck_id,card_id,revision,version,rating,reviewed_at,introduced,schedule,due_at,card_revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[actor.id,eventId,deckId,cardId,revision,version+1,rating,state.now,!prior,next,next.due,cardRevision]);
    return {eventId,version:version+1,dueAt:next.due};
  }));
}
