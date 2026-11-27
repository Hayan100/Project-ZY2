import type {FastifyInstance} from "fastify";
import type {PoolClient} from "pg";
import {fail,type Academic,type sessionTransaction} from "./authorized.ts";
const uuid={type:"string",format:"uuid"};
const obj=(properties:Record<string,object>)=>({type:"object",properties,required:Object.keys(properties),additionalProperties:false});
type Material={id:string;kind:"page"|"card"|"question"|"lesson";source:string;revision:number;target:string;title:string};
const params=obj({id:uuid});
async function material(tx:PoolClient,m:Material) {
  const args=[m.source,m.revision,m.target];
  const sql={
    page:`SELECT p AS item FROM ebooks b JOIN ebook_revisions r ON (r.book_id,r.revision)=(b.id,b.published_revision)
      CROSS JOIN LATERAL jsonb_array_elements(r.manuscript->'pages') p WHERE b.id=$1 AND r.revision=$2 AND p->>'id'=$3`,
    card:`SELECT jsonb_build_object('id',c.card_id,'front',c.front,'back',c.back) AS item FROM published_decks d
      JOIN academy_cards c ON c.owner_deck=d.deck_id WHERE d.deck_id=$1 AND d.revision=$2 AND c.card_id=$3::uuid
      AND EXISTS(SELECT FROM jsonb_array_elements(d.deck->'cards') x WHERE x->>'id'=c.card_id::text)`,
    question:`SELECT q AS item FROM (SELECT revision,quiz FROM quiz_revisions WHERE quiz_id=$1 AND published_at IS NOT NULL
      ORDER BY revision DESC LIMIT 1) r CROSS JOIN LATERAL jsonb_array_elements(r.quiz->'questions') q WHERE r.revision=$2 AND q->>'id'=$3`,
    lesson:`SELECT jsonb_build_object('id',l->>'id','type',l->>'type','title',l->>'title') AS item
      FROM courses c JOIN course_revisions r ON (r.course_id,r.revision)=(c.id,c.published_revision)
      CROSS JOIN LATERAL jsonb_array_elements(r.outline->'chapters') ch CROSS JOIN LATERAL jsonb_array_elements(ch->'lessons') l
      WHERE c.id=$1 AND r.revision=$2 AND l->>'id'=$3`
  };
  return (await tx.query(sql[m.kind],args)).rows[0]?.item;
}
export function registerSamples(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>,academic:Academic) {
  const base="/api/v1/samples",staff="/api/v1/staff/samples";
  app.post<{Body:Material}>(staff,{schema:{body:obj({id:uuid,kind:{enum:["page","card","question","lesson"]},source:uuid,
    revision:{type:"integer",minimum:1},target:uuid,title:{type:"string",pattern:"\\S",maxLength:200}})}},req=>academic(req,async(tx,a)=>{
    const m=req.body;
    if(!await material(tx,m)) fail(404);
    await tx.query("INSERT INTO sample_materials VALUES ($1,$2,$3,$4,$5,$6,true,$7)",[m.id,m.kind,m.source,m.revision,m.target,m.title,a]);
    return {id:m.id};
  }));
  app.put<{Params:{id:string};Body:{enabled:boolean}}>(staff+"/:id",{schema:{params,body:obj({enabled:{type:"boolean"}})}},
    req=>academic(req,async tx=>(await tx.query("UPDATE sample_materials SET enabled=$2 WHERE id=$1 RETURNING id,enabled",
      [req.params.id,req.body.enabled])).rows[0]??fail(404)));
  app.get(base,req=>session(req,async tx=>{
    const {rows}=await tx.query<Material>("SELECT * FROM sample_materials WHERE enabled ORDER BY title,id");
    const samples=[];
    for(const m of rows) if(await material(tx,m)) samples.push({id:m.id,kind:m.kind,title:m.title});
    return {samples};
  }));
  async function sample(tx:PoolClient,id:string) {
    const m=(await tx.query<Material>("SELECT * FROM sample_materials WHERE id=$1 AND enabled",[id])).rows[0]??fail(404);
    return {m,item:await material(tx,m)??fail(404)};
  }
  app.get<{Params:{id:string}}>(base+"/:id",{schema:{params}},req=>session(req,async(tx,a)=>{
    const {m,item}=await sample(tx,req.params.id);
    if(m.kind!=="question") return {kind:m.kind,item};
    const prior=(await tx.query("SELECT choice FROM sample_practice WHERE student=$1 AND sample=$2",[a.id,m.id])).rows[0];
    return {kind:m.kind,item:prior?{...item,choice:prior.choice}:{id:item.id,stem:item.stem,options:item.options}};
  }));
  app.put<{Params:{id:string};Body:{choice:string}}>(base+"/:id/answer",{schema:{params,body:obj({choice:uuid})}},req=>session(req,async(tx,a)=>{
    const {m,item}=await sample(tx,req.params.id);
    if(m.kind!=="question" || !item.options.some((o:{id:string})=>o.id===req.body.choice)) fail(422);
    const args=[a.id,m.id,req.body.choice];
    await tx.query("INSERT INTO sample_practice VALUES($1,$2,$3) ON CONFLICT DO NOTHING",args);
    if(!(await tx.query("SELECT FROM sample_practice WHERE (student,sample,choice)=($1,$2,$3)",args)).rowCount) fail(409);
    return {correct:item.correctOptionId===req.body.choice,explanation:item.explanation};
  }));
}
