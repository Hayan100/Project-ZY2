import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, type Academic, type sessionTransaction } from "./authorized.ts";
import { loadCourse } from "./learning.ts";

type Page = { id: string; title: string; blocks: { type: "paragraph" | "heading"; text: string }[] };
type Manuscript = { title: string; exam: string; subject: string; pages: Page[] };
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
const manuscriptSchema = object({title, subject:title, exam:title, pages:{type:"array",items:page,maxItems:1000}});
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
        const { pages }=(await tx.query("SELECT manuscript FROM ebook_revisions WHERE book_id=$1 AND revision=$2",[id,version])).rows[0].manuscript as Manuscript;
        if (!pages.length || pages.some(p=>!p.blocks.length)) fail(422);
        await tx.query("UPDATE ebooks SET published_revision=$2 WHERE id=$1",[id,version]);
        await tx.query("UPDATE ebook_revisions SET published_by=$3,published_at=now() WHERE book_id=$1 AND revision=$2",[id,version,user]);
      }
      return { id,publishedRevision:version };
    }));

  async function bookFor(tx:PoolClient,user:string,id:string,query:Reader["Querystring"],write=false) {
    let linked = false;

    if (query.courseId && query.lessonId) {
      const course=await loadCourse(tx,accessible,user,query.courseId,write);
      const lesson=course.available(query.lessonId);
      if (!(lesson.type==="html_article" && lesson.resourceId===id) && !lesson.relatedResourceIds?.includes(id)) fail(404);
      linked=true;

    }
    const result=await tx.query<{revision:number;manuscript:Manuscript}>(
      `SELECT r.revision,r.manuscript ${published} WHERE b.id=$2 AND ($3 OR ${entitled}) ${write?"FOR SHARE OF b":""}`,[user,id,linked]);
    return result.rows[0] ?? fail(404);
  }
  app.get<{Querystring:{q?:string}}>(library,{schema:{querystring:object({q:{type:"string",maxLength:200}},[])}},
    req=>session(req,async (tx,actor)=>({ebooks:(await tx.query(`SELECT b.id,r.revision,r.manuscript->>'title' AS title,
      r.manuscript->>'exam' AS exam,r.manuscript->>'subject' AS subject,reading."resumePageId",reading.visited,reading.studied,
      jsonb_array_length(r.manuscript->'pages') AS "totalPages" ${published}
      CROSS JOIN LATERAL (SELECT (array_agg(p.page_id ORDER BY p.last_read_at DESC,p.page_id))[1] AS "resumePageId",
        count(*)::int AS visited,count(*) FILTER(WHERE p.studied)::int AS studied
        FROM jsonb_array_elements(r.manuscript->'pages') page JOIN ebook_reading p
        ON p.page_id=(page->>'id')::uuid AND p.book_id=b.id AND p.user_id=$1) reading
      WHERE ${entitled} AND strpos(lower(concat_ws(' ',r.manuscript->>'title',r.manuscript->>'subject',r.manuscript->>'exam')),lower($2))>0
      ORDER BY exam,subject,title,b.id`,[actor.id,req.query.q ?? ""])).rows})));
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
  app.get<PageRoute>(pagePath,{schema:pageSchema},req=>session(req,async (tx,actor)=>{
    const book=await bookFor(tx,actor.id,req.params.id,req.query);
    const page=book.manuscript.pages.find(p=>p.id===req.params.pageId) ?? fail(404);
    return {revision:book.revision,page};
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
}
