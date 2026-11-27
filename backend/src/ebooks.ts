import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, type Academic, type sessionTransaction } from "./authorized.ts";
import { loadCourse } from "./learning.ts";
import {ebookDelivery} from "./content-access.ts";
import {pdfStamp,mediaViewer,escape,phoneForm,phoneSubmit} from "./media-watermark.ts";
import {randomUUID} from "node:crypto";
import {stampPage,readPage} from "./stamp-page.ts";

type Page = { id: string; title: string; blocks: { type: "paragraph" | "heading"; text: string }[] };
type Manuscript = { title: string; exam: string; subject: string; pdfAssetId?:string; pages: Page[] };
type Book = { Params: { id: string } };
type Reader = Book & { Querystring: { courseId?: string; lessonId?: string } };
type PageRoute = Reader & { Params: { id:string; pageId:string } };

const uuid = {type:"string", format:"uuid", pattern:"^[0-9a-f-]+$"};
const revision = {type:"integer", minimum:1, maximum:2147483647};
const title = {type:"string", maxLength:200, pattern:"\\S"};
const object = (properties:Record<string,object>, required=Object.keys(properties)) =>
  ({type:"object",properties,required,additionalProperties:false});
const block = object({type:{enum:["heading","paragraph"]}, text:{...title,maxLength:20000}});
const page = object({id:uuid,title,blocks:{type:"array",items:block,maxItems:500}});
const manuscriptSchema = object({title, subject:title, exam:title,pdfAssetId:uuid, pages:{type:"array",items:page,maxItems:1000}},["title","subject","exam","pages"]);
const bodyLimit = 4 * 1024 * 1024;
const params = object({id:uuid});
const context = { ...object({courseId:uuid,lessonId:uuid},[]), dependencies:{courseId:["lessonId"],lessonId:["courseId"]} };
const published = `FROM ebooks b JOIN ebook_revisions r ON (b.id,b.published_revision)=(r.book_id,r.revision)`;
const entitled = `EXISTS (SELECT FROM enrollments e WHERE e.user_id=$1 AND e.product_key=b.library_product_key
  AND e.starts_at<=now() AND now()<e.ends_at AND e.revoked_at IS NULL)`;

async function save(tx: PoolClient, id:string, version:number, manuscript:Manuscript, user:string) {
  if (new Set(manuscript.pages.map(p=>p.id)).size !== manuscript.pages.length) fail(400);
  await tx.query("INSERT INTO ebook_revisions(book_id,revision,manuscript,authored_by) VALUES ($1,$2,$3,$4)",
    [id,version,manuscript,user]);
  return { id, revision:version };
}

export async function libraryBooks(tx:PoolClient,user:string,query="",linkedBookIds?:string[]) {
  return (await tx.query(`SELECT b.id,r.revision,r.manuscript->>'title' AS title,
      r.manuscript->>'exam' AS exam,r.manuscript->>'subject' AS subject,reading."resumePageId",reading.visited,reading.studied,
      jsonb_array_length(r.manuscript->'pages') AS "totalPages" ${published}
      CROSS JOIN LATERAL (SELECT (array_agg(p.page_id ORDER BY p.last_read_at DESC,p.page_id))[1] AS "resumePageId",
        count(*)::int AS visited,count(*) FILTER(WHERE p.studied)::int AS studied
        FROM jsonb_array_elements(r.manuscript->'pages') page JOIN ebook_reading p
        ON p.page_id=(page->>'id')::uuid AND p.book_id=b.id AND p.user_id=$1) reading
      WHERE ${linkedBookIds ? "b.id=ANY($3::uuid[])" : entitled} AND strpos(lower(concat_ws(' ',r.manuscript->>'title',r.manuscript->>'subject',r.manuscript->>'exam')),lower($2))>0
      ORDER BY exam,subject,title,b.id`,linkedBookIds ? [user,query,linkedBookIds] : [user,query])).rows;
}

export async function lastReadPage(tx:PoolClient,user:string,allowedIds?:string[]) {
  return (await tx.query(`SELECT b.id AS "bookId",p.page_id AS "pageId",r.manuscript->>'title' AS title
    ${published} JOIN ebook_reading p ON p.book_id=b.id WHERE p.user_id=$1
    AND ${allowedIds ? "b.id=ANY($2::uuid[])" : entitled}
    AND EXISTS(SELECT FROM jsonb_array_elements(r.manuscript->'pages') page WHERE page->>'id'=p.page_id::text)
    ORDER BY p.last_read_at DESC,p.page_id,b.id LIMIT 1`,allowedIds ? [user,allowedIds] : [user])).rows[0];
}

export function registerEbooks(app:FastifyInstance, session:ReturnType<typeof sessionTransaction>, academic:Academic, accessible:string) {
  const staff = "/api/v1/staff/ebooks";
  const library = "/api/v1/ebooks";
  app.post<{Body:{id:string;libraryProductKey?:string;manuscript:Manuscript}}>(staff, {bodyLimit,
    schema:{body:object({id:uuid,libraryProductKey:{...title,maxLength:120},manuscript:manuscriptSchema},["id","manuscript"])}
  }, (req, reply) => academic(req, async (tx,user) => {
    const {id, libraryProductKey, manuscript} = req.body;
    await tx.query("INSERT INTO ebooks(id,library_product_key) VALUES ($1,$2)",[id,libraryProductKey]);
    const result = await save(tx,id,1,manuscript,user);
    reply.code(201);
    return result;
  }));
  app.get(staff,req=>academic(req,async tx=>({ebooks:(await tx.query(`SELECT b.id,b.revision,
    b.published_revision AS "publishedRevision",r.manuscript->>'title' AS title FROM ebooks b
    JOIN ebook_revisions r ON (b.id,b.revision)=(r.book_id,r.revision) ORDER BY title,b.id`)).rows})));
  app.get<Book & {Querystring:{revision?:number}}>(staff+"/:id",{schema:{params,querystring:object({revision},[])}},
    req=>academic(req,async tx=>(await tx.query(`SELECT b.id,r.revision,b.library_product_key AS "libraryProductKey",
      b.published_revision AS "publishedRevision",r.manuscript,r.authored_by AS "authoredBy",r.published_by AS "publishedBy"
      FROM ebooks b JOIN ebook_revisions r ON b.id=r.book_id AND r.revision=coalesce($2,b.revision)
      WHERE b.id=$1`,[req.params.id,req.query.revision])).rows[0] ?? fail(404)));
  app.put<Book & {Body:{revision:number;manuscript:Manuscript}}>(staff+"/:id",{bodyLimit,
    schema:{params,body:object({revision,manuscript:manuscriptSchema})}
  }, req=>academic(req,async (tx,user)=>{
    const result=await tx.query("UPDATE ebooks SET revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING revision",
      [req.params.id,req.body.revision]);
    if (!result.rowCount) fail(409);
    return save(tx,req.params.id,result.rows[0].revision,req.body.manuscript,user);
  }));
  app.post<Book & {Body:{revision:number}}>(staff+"/:id/publish",{schema:{params,body:object({revision})}},
    req=>academic(req,async (tx,user)=>{
      const id=req.params.id, version=req.body.revision;
      const book=(await tx.query("SELECT revision,published_revision FROM ebooks WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if (!book) return fail(404);
      if (book.published_revision!==version) {
        if (book.revision!==version) fail(409);
        const {pages,pdfAssetId}=(await tx.query("SELECT manuscript FROM ebook_revisions WHERE book_id=$1 AND revision=$2",[id,version])).rows[0].manuscript as Manuscript;
        if (!pages.length || !pdfAssetId && pages.some(p=>!p.blocks.length)) fail(422);
        await tx.query("UPDATE ebooks SET published_revision=$2 WHERE id=$1",[id,version]);
        await tx.query("UPDATE ebook_revisions SET published_by=$3,published_at=now() WHERE book_id=$1 AND revision=$2",[id,version,user]);
      }
      return { id,publishedRevision:version };
    }));

  async function bookFor(tx:PoolClient,user:string,id:string,query:Reader["Querystring"],write=false) {
    let linked = false;

    if (query.courseId && query.lessonId) {
      const course=await loadCourse(tx,accessible,user,query.courseId,write,query.lessonId);
      const lesson=course.available(query.lessonId);
      if (!(lesson.type==="html_article" && lesson.resourceId===id) && !lesson.relatedResourceIds?.includes(id)) fail(404);
      linked=true;

    }
    const result=await tx.query<{revision:number;manuscript:Manuscript}>(
      `SELECT r.revision,r.manuscript ${published} WHERE b.id=$2 AND ($3 OR ${entitled}) ${write?"FOR SHARE OF b":""}`,[user,id,linked]);
    return result.rows[0] ?? fail(404);
  }
  app.get<{Querystring:{q?:string}}>(library,{schema:{querystring:object({q:{type:"string",maxLength:200}},[])}},
    req=>session(req,async (tx,actor)=>({ebooks:await libraryBooks(tx,actor.id,req.query.q ?? "")})));
  app.get<{Querystring:{q?:string}}>(library+"/home",{schema:{querystring:object({q:{type:"string",maxLength:200}},[])}},
    req=>session(req,async (tx,actor)=>{
      const books=await libraryBooks(tx,actor.id,req.query.q?.trim());
      const myBooks:{exam:string;subject:string;books:typeof books}[]=[];
      for(const book of books) {
        let shelf=myBooks.at(-1);
        if(!shelf || shelf.exam!==book.exam || shelf.subject!==book.subject) {
          shelf={exam:book.exam,subject:book.subject,books:[]};
          myBooks.push(shelf);
        }
        shelf.books.push({...book,href:library+"/"+book.id});
      }
      const last=await lastReadPage(tx,actor.id);
      return {continueReading:last?{...last,href:library+"/"+last.bookId}:null,myBooks};
    }));
  app.get<Reader>(library+"/:id",{schema:{params,querystring:context}},req=>session(req,async (tx,actor)=>{
    const book=await bookFor(tx,actor.id,req.params.id,req.query);
    const saved=await tx.query("SELECT page_id,studied FROM ebook_reading WHERE user_id=$1 AND book_id=$2 ORDER BY last_read_at DESC,page_id",
      [actor.id,req.params.id]);
    const state=new Map(saved.rows.map(p=>[p.page_id,p.studied]));
    const {pages,...metadata}=book.manuscript;
    const current=new Set(pages.map(p=>p.id));
    return {id:req.params.id,revision:book.revision,...metadata,resumePageId:saved.rows.find(p=>current.has(p.page_id))?.page_id ?? null,
      pages:pages.map(p=>({id:p.id,title:p.title,visited:state.has(p.id),studied:state.get(p.id) ?? false}))};
  }));
  app.get<Reader & { Querystring:{q:string} }>(library+"/:id/search",{
    schema:{params,querystring:{...context,properties:{...context.properties,q:{...title,maxLength:200}},required:["q"]}}
  },req=>session(req,async(tx,actor)=>{
    const book=await bookFor(tx,actor.id,req.params.id,req.query);
    const term=req.query.q.trim().toLowerCase();
    const pages=book.manuscript.pages.filter(p=>p.title.toLowerCase().includes(term) ||
      p.blocks.some(block=>block.text.toLowerCase().includes(term)));
    return {revision:book.revision,pages:pages.map(({id,title})=>({id,title}))};
  }));
  const pagePath=library+"/:id/pages/:pageId";
  const pageSchema={params:object({id:uuid,pageId:uuid}),querystring:context};
  app.route<PageRoute>({method:["GET","POST"],url:pagePath+"/pdf-access",schema:pageSchema,handler:async(req,reply)=>{
    async function authorizedPage(record:boolean) {
      return session(req,async(tx,a)=>{
        const book=await bookFor(tx,a.id,req.params.id,req.query);
        const index=book.manuscript.pages.findIndex(p=>p.id===req.params.pageId);
        if(index<0 || !book.manuscript.pdfAssetId) return fail(404);
        if(record && !await ebookDelivery(tx,a.id,req.params.id,req.params.pageId,req.query.courseId)) return null;
        const watermark=pdfStamp(await mediaViewer(tx,a.id));
        return {assetId:book.manuscript.pdfAssetId,page:index+1,student:a.id,session:a.session,revision:book.revision,watermark};
      });
    }
    const source=await authorizedPage(false);
    if(!source) return fail(403);
    if(!process.env.PDF_PAGE_URL) return fail(503);
    const stampId=randomUUID();
    const res=await fetch(process.env.PDF_PAGE_URL,{method:"POST",redirect:"error",signal:AbortSignal.timeout(8000),
      headers:{"Content-Type":"application/json",...(process.env.PDF_PAGE_TOKEN?{Authorization:"Bearer "+process.env.PDF_PAGE_TOKEN}:{})},
      body:JSON.stringify({assetId:source.assetId,page:source.page,student:source.student,revision:source.revision,watermark:source.watermark,stampId})});
    if(!res.ok) return fail(503);
    const ticket=await res.json() as {url?:string;expiresAt?:string;appliedStampId?:string};
    if(!ticket.url || !URL.canParse(ticket.url) || new URL(ticket.url).protocol!=="https:" || !ticket.expiresAt ||
      !(Date.parse(ticket.expiresAt)>Date.now() && Date.parse(ticket.expiresAt)<=Date.now()+60000)) return fail(503);
    const needsStamp=ticket.appliedStampId!==stampId;
    const localPage=req.method==="GET" && needsStamp
      ?await stampPage(await readPage(await fetch(ticket.url,{redirect:"error",signal:AbortSignal.timeout(8000)})),source.watermark.svg)
      :null;
    const current=await authorizedPage(true);
    if(!current) return reply.code(429).send({error:"Reading access temporarily held for verification"});
    if(source.session!==current.session || source.revision!==current.revision || source.watermark.label!==current.watermark.label) return fail(409);
    if(localPage)return reply.type(localPage.type).send(localPage.bytes);
    if(req.method==="GET")return reply.redirect(ticket.url);
    return {url:needsStamp?req.url:ticket.url,expiresAt:ticket.expiresAt};
  }});
  type Ink={id:string;revision:number;version:number;points:number[][]};
  const coordinate={type:"number",minimum:0,maximum:1};
  app.put<PageRoute & {Body:Ink}>(pagePath+"/ink",{schema:{...pageSchema,body:object({id:uuid,revision,
    version:{type:"integer",minimum:0,maximum:2147483646},points:{type:"array",maxItems:2048,
      items:{type:"array",items:coordinate,minItems:2,maxItems:2}}})}},req=>session(req,async(tx,a)=>{
    const b=req.body,book=await bookFor(tx,a.id,req.params.id,req.query,true);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,38))",[a.id+b.id]);
    const prior=(await tx.query(`SELECT * FROM page_ink WHERE student=$1 AND id=$2 ORDER BY version DESC LIMIT 1`,[a.id,b.id])).rows[0];
    if(prior && (prior.book!==req.params.id || prior.page!==req.params.pageId || prior.revision!==b.revision)) fail(409);
    if(prior?.version===b.version+1 && JSON.stringify(prior.points)===JSON.stringify(b.points)) return {id:b.id,version:prior.version};
    if((prior?.version??0)!==b.version) fail(409);
    if(!prior && (book.revision!==b.revision || !book.manuscript.pdfAssetId || !book.manuscript.pages.some(p=>p.id===req.params.pageId))) fail(409);
    return (await tx.query(`INSERT INTO page_ink(student,id,version,book,page,revision,points)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,version`,[a.id,b.id,b.version+1,req.params.id,req.params.pageId,b.revision,JSON.stringify(b.points)])).rows[0];
  }));
  app.get<Reader>(library+"/:id/ink",{schema:{params,querystring:context}},req=>session(req,async(tx,a)=>{
    const book=await bookFor(tx,a.id,req.params.id,req.query);
    const {rows}=await tx.query(`SELECT DISTINCT ON(i.id) i.id,i.page,i.version,i.revision,i.points,
      coalesce(r.manuscript->>'pdfAssetId'=$3 AND original.n=current_page.n,false) AS resolved FROM page_ink i
      JOIN ebook_revisions r ON (r.book_id,r.revision)=(i.book,i.revision)
      CROSS JOIN LATERAL jsonb_array_elements(r.manuscript->'pages') WITH ORDINALITY original(p,n)
      LEFT JOIN LATERAL (SELECT n FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY current(p,n) WHERE p->>'id'=i.page::text) current_page ON true
      WHERE i.student=$1 AND i.book=$2 AND original.p->>'id'=i.page::text ORDER BY i.id,i.version DESC`,
      [a.id,req.params.id,book.manuscript.pdfAssetId,JSON.stringify(book.manuscript.pages.map(p=>({id:p.id})))]);
    return {strokes:rows.filter(s=>s.points.length)};
  }));
  type Annotation={id:string;revision:number;version:number;start:number;end:number;body:string};
  app.put<PageRoute & {Body:Annotation}>(pagePath+"/annotations",{schema:{...pageSchema,body:object({
    id:uuid,revision,version:{type:"integer",minimum:0,maximum:2147483646},
    start:{type:"integer",minimum:0},end:{type:"integer",minimum:1},body:{type:"string",maxLength:20000}
  })}},req=>session(req,async(tx,actor)=>{
    const {id,revision,version,start,end,body}=req.body;
    const book=await bookFor(tx,actor.id,req.params.id,req.query,true);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,23))",[actor.id+id]);
    const prior=(await tx.query(`SELECT * FROM ebook_annotations WHERE student=$1 AND id=$2 ORDER BY version DESC LIMIT 1`,
      [actor.id,id])).rows[0];
    if(prior && (prior.book!==req.params.id || prior.page!==req.params.pageId || prior.revision!==revision ||
      prior.start_offset!==start || prior.end_offset!==end)) fail(409);
    if(prior?.version===version+1 && prior.body===body) return {id,version:prior.version};
    if((prior?.version??0)!==version) fail(409);
    if(!prior) {
      if(book.revision!==revision) fail(409);
      const page=book.manuscript.pages.find(p=>p.id===req.params.pageId)??fail(404);
      if(start>=end || end>page.blocks.map(b=>b.text).join("\n").length) fail(422);
    }
    await tx.query(`INSERT INTO ebook_annotations(student,id,book,page,revision,start_offset,end_offset,body,version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[actor.id,id,req.params.id,req.params.pageId,revision,start,end,body,version+1]);
    return {id,version:version+1};
  }));
  app.get<Reader>(library+"/:id/annotations",{schema:{params,querystring:context}},req=>session(req,async(tx,actor)=>{
    const book=await bookFor(tx,actor.id,req.params.id,req.query);
    const {rows}=await tx.query(`SELECT DISTINCT ON (a.id) a.id,a.page,a.revision,a.start_offset AS start,
      a.end_offset AS "end",a.body,a.version,coalesce(original->'blocks'=current_page->'blocks',false) AS resolved
      FROM ebook_annotations a JOIN ebook_revisions r ON (r.book_id,r.revision)=(a.book,a.revision)
      CROSS JOIN LATERAL jsonb_array_elements(r.manuscript->'pages') original
      JOIN ebook_revisions c ON (c.book_id,c.revision)=(a.book,$3)
      LEFT JOIN LATERAL (SELECT p AS current_page FROM jsonb_array_elements(c.manuscript->'pages') p
        WHERE p->>'id'=a.page::text) latest ON true
      WHERE a.student=$1 AND a.book=$2 AND original->>'id'=a.page::text ORDER BY a.id,a.version DESC`,
      [actor.id,req.params.id,book.revision]);
    return {annotations:rows};
  }));
  app.get<{Params:{id:string}} >("/api/v1/me/annotations/:id/history",{schema:{params}},req=>session(req,async(tx,a)=>({
    versions:(await tx.query(`SELECT book,page,revision,start_offset AS start,end_offset AS "end",body,version
      FROM ebook_annotations WHERE student=$1 AND id=$2 ORDER BY version DESC`,[a.id,req.params.id])).rows
  })));
  app.get<PageRoute>(pagePath,{schema:pageSchema},(req,reply)=>session(req,async (tx,actor)=>{
    const book=await bookFor(tx,actor.id,req.params.id,req.query);
    const page=book.manuscript.pages.find(p=>p.id===req.params.pageId) ?? fail(404);
    if(!await ebookDelivery(tx,actor.id,req.params.id,page.id,req.query.courseId)) {
      reply.code(429);
      return {error:"Reading access temporarily held for verification"};
    }
    const viewer=await mediaViewer(tx,actor.id);
    if(!viewer.phone){
      if(req.headers.accept?.includes("text/html")){
        const nonce=randomUUID();
        return reply.header("Content-Security-Policy",`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'self'`)
          .type("text/html; charset=utf-8").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reading access</title>${phoneForm}<output></output><script nonce="${nonce}">${phoneSubmit}</script>`);
      }
      return reply.code(422).send({error:"Mobile number required for the reading watermark",profileHref:"/api/v1/me/watermark-phone"});
    }
    const watermark=pdfStamp(viewer);
    reply.header("Vary","Accept");
    if(req.headers.accept?.includes("text/html")){
      if(book.manuscript.pdfAssetId){
        const url=req.url.split("?")[0]+"/pdf-access"+(req.url.includes("?")?"?"+req.url.split("?")[1]:"");
        return reply.redirect(url);
      }
      const blocks=page.blocks.map(b=>b.type==="heading"?"<h2>"+escape(b.text)+"</h2>":"<p>"+escape(b.text)+"</p>").join("");
      const nonce=randomUUID();
      return reply.header("Content-Security-Policy",`default-src 'none'; style-src 'nonce-${nonce}'; frame-ancestors 'self'`)
        .type("text/html; charset=utf-8").send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(page.title)}</title><style nonce="${nonce}">body{margin:0;background:#eef1f5}article{box-sizing:border-box;position:relative;max-width:60rem;min-height:100vh;margin:auto;padding:clamp(1rem,5vw,4rem);background:white;color:#18283a;font:1.15rem/1.65 Georgia,serif;overflow-wrap:anywhere}article>svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;user-select:none}p{white-space:pre-wrap}</style><article><h1>${escape(page.title)}</h1>${blocks}${watermark.svg}</article></html>`);
    }
    return {revision:book.revision,page,watermark};
  }));
  app.put<PageRoute & {Body:{revision:number;studied?:boolean}}>(pagePath+"/reading",{
    schema:{...pageSchema,body:object({revision,studied:{type:"boolean"}},["revision"])}
  },req=>session(req,async (tx,actor)=>{
    const book=await bookFor(tx,actor.id,req.params.id,req.query,true);
    if (book.revision!==req.body.revision) fail(409);
    if (!book.manuscript.pages.some(p=>p.id===req.params.pageId)) fail(404);
    const result=await tx.query(`INSERT INTO ebook_reading(user_id,book_id,page_id,studied) VALUES ($1,$2,$3,coalesce($4,false))
      ON CONFLICT(user_id,book_id,page_id) DO UPDATE SET last_read_at=clock_timestamp(),studied=coalesce($4,ebook_reading.studied)
      RETURNING page_id AS "pageId",studied`,[actor.id,req.params.id,req.params.pageId,req.body.studied]);
    return result.rows[0];
  }));
  return bookFor;
}
