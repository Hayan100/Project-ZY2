import { fail, sessionTransaction, type Identity } from "./authorized.ts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import sharp from "sharp";

type Actor = { id: string; sales: boolean; verifier: boolean; plan_approver: boolean; session: string };
const uuid = { type: "string", format: "uuid" };
const revision = { type: "integer", minimum: 1, maximum: 2147483647 };
const params = { type: "object", properties: { id: uuid }, required: ["id"] };
const body = (properties: Record<string, object>, required = Object.keys(properties)) =>
  ({ type: "object", properties, required, additionalProperties: false });

const summary = `SELECT i.id,i.student_id,i.offer_id,i.issued_at,o.product_key,o.amount_paisa,o.instructions,
  o.receiving_account,o.policy_version,o.policy_text,o.support_contact,o.starts_at,o.ends_at,o.duration_days,o.batch_id,
  p.revision,p.submitted_at,p.correction,p.submitted_at+make_interval(hours=>o.review_hours) AS review_due,
  b.balance_paisa,b.paid_paisa,b.paid_parts,b.next_due,ip.schedule,ip.approved_at,ip.agreed_at,
  CASE WHEN b.balance_paisa=0 THEN 'paid' WHEN ip.invoice_id IS NOT NULL AND ip.approved_at IS NULL THEN 'plan_pending'
       WHEN r.revision=p.revision THEN 'awaiting_installment' WHEN p.correction IS NOT NULL THEN 'correction'
       WHEN p.revision IS NOT NULL THEN 'in_review' ELSE 'awaiting_proof' END AS status,
  r.verified_at,r.enrollment_id,r.transfer_reference,r.transferred_at
  FROM payment_invoices i JOIN payment_offers o ON o.id=i.offer_id
  LEFT JOIN LATERAL (SELECT revision,submitted_at,correction FROM payment_proofs WHERE invoice_id=i.id ORDER BY revision DESC LIMIT 1) p ON true
  JOIN installment_balance b ON b.id=i.id LEFT JOIN installment_plans ip ON ip.invoice_id=i.id
  LEFT JOIN LATERAL (SELECT * FROM payment_receipts WHERE invoice_id=i.id ORDER BY part DESC LIMIT 1) r ON true`;

export function registerPayments(app: FastifyInstance, db: Pool, principal: Identity, origin: string, googleAvailable = false) {
  app.get<{ Params: { id: string } }>("/api/v1/checkout/:id", {schema:{params}}, async req => {
    const [offer,identity] = await Promise.all([
      db.query("SELECT id,product_key,amount_paisa,policy_version,policy_text,starts_at,ends_at,duration_days FROM payment_offers WHERE id=$1 AND enabled AND (ends_at IS NULL OR ends_at>now())", [req.params.id]),
      principal(req.headers.cookie),
    ]);
    const pending = identity && await db.query(`SELECT i.id FROM payment_invoices i WHERE i.student_id=$1 AND i.offer_id=$2
      AND EXISTS (SELECT FROM installment_balance WHERE id=i.id AND balance_paisa>0) ORDER BY i.issued_at DESC LIMIT 1`,[identity.user.id,req.params.id]);
    const invoiceId = pending?.rows[0]?.id;
    if (invoiceId) return { next:"resume_invoice", invoiceId, checkoutOfferId:req.params.id };
    if (!offer.rowCount) return fail(404);
    const next = identity?.user.emailVerified ? "confirm_invoice" : "authenticate";
    return { offer:offer.rows[0], next, checkoutOfferId:req.params.id, googleAvailable };
  });
  const withSession = sessionTransaction(db, principal, origin);
  function authorized<T>(req: FastifyRequest, work: (tx: PoolClient, actor: Actor) => Promise<T>) {
    return withSession(req, async (tx, actor) => {
      const permissions = await tx.query("SELECT sales,verifier,plan_approver FROM payment_permissions WHERE staff_id=$1", [actor.id]);
      return work(tx, { ...actor, ...permissions.rows[0] });
    });
  }
  async function lock(tx: PoolClient, value: string, namespace: number) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,$2))", [value,namespace]);
  }
  async function invoiceFor(tx: PoolClient, actor: Actor, id: string, write = false, reviewPlan = false) {
    if (write) await lock(tx,id.toLowerCase(),2);
    const { rows } = await tx.query(summary + " WHERE i.id=$1 AND (i.student_id=$2 OR ((i.created_by=$2 OR i.assigned_sales=$2) AND $3) OR $4)",
      [id,actor.id,Boolean(actor.sales),Boolean((actor.verifier || (reviewPlan && actor.plan_approver)) && !write)]);
    return rows[0] ?? fail(404);
  }
  app.post<{ Body: { id: string; offerId: string; studentId?: string; policyVersion: string } }>("/api/v1/invoices", {
    schema: { body: body({id:uuid,offerId:uuid,studentId:{type:"string",minLength:1,maxLength:200},policyVersion:{type:"string",minLength:1,maxLength:200}}, ["id","offerId","policyVersion"]) },
  }, req => authorized(req, async (tx,actor) => {
    const { id,offerId,policyVersion } = req.body;
    const student = req.body.studentId ?? actor.id;
    if (student !== actor.id && !actor.sales) fail(403);
    await lock(tx,student,1);
    const prior = await tx.query("SELECT * FROM payment_invoices WHERE id=$1", [id]);
    if (prior.rows.length) {
      const i = prior.rows[0];
      if (i.student_id !== student || i.created_by !== actor.id || i.offer_id !== offerId) fail(409);
      return invoiceFor(tx,actor,id);
    }
    const created = await tx.query(`INSERT INTO payment_invoices(id,student_id,created_by,offer_id)
      SELECT $1,$2,$3,o.id FROM payment_offers o WHERE o.id=$4 AND enabled AND policy_version=$5
      AND EXISTS (SELECT FROM "user" WHERE id=$2 AND "emailVerified")
      AND (ends_at IS NULL OR ends_at>now())
      AND NOT EXISTS (SELECT FROM admission_batches WHERE id=o.batch_id AND occupied>=capacity)
      AND NOT EXISTS (SELECT FROM enrollments e WHERE e.user_id=$2 AND e.product_key=o.product_key AND e.revoked_at IS NULL
        AND e.starts_at<coalesce(o.ends_at,now()+make_interval(days=>o.duration_days)) AND coalesce(o.starts_at,now())<e.ends_at)
      AND NOT EXISTS (SELECT FROM payment_invoices i JOIN payment_offers x ON x.id=i.offer_id
        WHERE i.student_id=$2 AND x.product_key=o.product_key AND NOT EXISTS (SELECT FROM payment_receipts WHERE invoice_id=i.id))
      RETURNING id`, [id,student,actor.id,offerId,policyVersion]);
    if (!created.rowCount) fail(409);
    return invoiceFor(tx,actor,id);
  }));
  app.get<{Params:{id:string}}>("/api/v1/invoices/:id",{schema:{params}},req =>
    authorized(req,(tx,actor) => invoiceFor(tx,actor,req.params.id)));
  app.post<{Params:{id:string};Body:{staffId:string}}>("/api/v1/invoices/:id/assign-sales",{
    schema:{params,body:body({staffId:{type:"string",minLength:1,maxLength:200}})},
  },req => authorized(req,async (tx,actor) => {
    await lock(tx,req.params.id.toLowerCase(),2);
    const result = await tx.query(`UPDATE payment_invoices SET assigned_sales=$3 WHERE id=$1 AND student_id=$2
      AND EXISTS (SELECT FROM payment_permissions WHERE staff_id=$3 AND sales)
      AND EXISTS (SELECT FROM installment_balance WHERE id=$1 AND balance_paisa>0)`,[req.params.id,actor.id,req.body.staffId]);
    if (!result.rowCount) fail(404);
    return { assigned:true };
  }));
  const phone={type:"string",pattern:"^\\+[1-9][0-9]{7,14}$"};
  app.post<{Body:{whatsapp:string}}>("/api/v1/me/receipt-whatsapp",{schema:{body:body({whatsapp:phone})}},req=>
    authorized(req,async(tx,actor)=>{
      await tx.query(`INSERT INTO receipt_contacts(user_id,whatsapp,consent_at) VALUES ($1,$2,now())
        ON CONFLICT(user_id) DO UPDATE SET whatsapp=excluded.whatsapp, verified_by=NULL, consent_at=now()
        WHERE receipt_contacts.whatsapp<>excluded.whatsapp`,[actor.id,req.body.whatsapp]);
      return {consent:true};
    }));
  app.delete("/api/v1/me/receipt-whatsapp",req=>authorized(req,async(tx,actor)=>{
    await tx.query("DELETE FROM receipt_contacts WHERE user_id=$1",[actor.id]);
    return {consent:false};
  }));
  app.post<{Body:{studentId:string;whatsapp:string}}>("/api/v1/payments/verify-whatsapp",{
    schema:{body:body({studentId:{type:"string",minLength:1,maxLength:200},whatsapp:phone})},
  },req=>authorized(req,async(tx,actor)=>{
    if (!actor.verifier || actor.id===req.body.studentId) fail(403);
    const result=await tx.query("UPDATE receipt_contacts SET verified_by=$1 WHERE user_id=$2 AND whatsapp=$3",
      [actor.id,req.body.studentId,req.body.whatsapp]);
    if (!result.rowCount) fail(409);
    return {verified:true};
  }));
  type Term = { amountPaisa: number; dueAt: string };
  const scheduleBody = body({schedule:{type:"array",minItems:2,maxItems:48,items:body({
    amountPaisa:{type:"integer",minimum:1,maximum:2147483647},dueAt:{type:"string",format:"date-time"},
  })}});
  for (const action of ["request","approve"] as const) {
    app.post<{Params:{id:string};Body:{schedule:Term[]}}>("/api/v1/invoices/:id/installments/"+action,
      {schema:{params,body:scheduleBody}}, req => authorized(req,async (tx,actor) => {
        const id=req.params.id.toLowerCase();
        await lock(tx,id,2);
        const i=await invoiceFor(tx,actor,id,false,action==="approve");
        const schedule=req.body.schedule.map(term=>({...term,dueAt:new Date(term.dueAt).toISOString()}));
        if (schedule.reduce((sum,t)=>sum+t.amountPaisa,0)!==i.amount_paisa ||
            schedule.some((t,n)=>n>0 && t.dueAt<=schedule[n-1].dueAt)) fail(400);
        const terms=JSON.stringify(schedule);
        if (action==="request") {
          if (actor.id!==i.student_id) fail(403);
          if (i.revision || i.approved_at) fail(409);
          await tx.query(`INSERT INTO installment_plans(invoice_id,agreed_by,schedule) VALUES ($1,$2,$3)
            ON CONFLICT(invoice_id) DO UPDATE SET schedule=excluded.schedule,agreed_at=now()
            WHERE installment_plans.approved_at IS NULL`,[id,actor.id,terms]);
        } else {
          if (!actor.plan_approver || actor.id===i.student_id) fail(403);
          const result=await tx.query(`UPDATE installment_plans SET approved_by=$2, approved_at=coalesce(approved_at,now())
            WHERE invoice_id=$1 AND schedule=$3 AND (approved_by IS NULL OR approved_by=$2)`,[id,actor.id,terms]);
          if (!result.rowCount) fail(409);
        }
        return invoiceFor(tx,actor,id,false,action==="approve");
      }));
  }
  app.get("/api/v1/payments/installment-requests",req=>authorized(req,async(tx,actor)=>{
    if (!actor.plan_approver) fail(403);
    return (await tx.query(summary+" WHERE ip.invoice_id IS NOT NULL AND ip.approved_at IS NULL ORDER BY ip.agreed_at,i.id LIMIT 100")).rows;
  }));
  app.post<{Params:{id:string}}>("/api/v1/invoices/:id/installments/withdraw",{schema:{params}},req=>authorized(req,async(tx,actor)=>{
    await lock(tx,req.params.id.toLowerCase(),2);
    const result=await tx.query("DELETE FROM installment_plans WHERE invoice_id=$1 AND agreed_by=$2 AND approved_at IS NULL",[req.params.id,actor.id]);
    if (!result.rowCount) fail(409);
    return {status:"awaiting_proof"};
  }));
  app.post<{Params:{id:string};Body:{part:number;dueAt:string;reason:string}}>("/api/v1/invoices/:id/installments/extend",{
    schema:{params,body:body({part:revision,dueAt:{type:"string",format:"date-time"},reason:{type:"string",minLength:1,maxLength:1000,pattern:"\\S"}})},
  },req=>authorized(req,async(tx,actor)=>{
    if (!actor.plan_approver) fail(403);
    const id=req.params.id.toLowerCase();
    await lock(tx,id,2);
    const i=await invoiceFor(tx,actor,id,false,true);
    if (i.student_id===actor.id) fail(403);
    const {part,reason,dueAt}=req.body;
    const date=new Date(dueAt);
    if (!i.next_due || i.paid_parts+1!==part || date<=i.next_due ||
        (i.schedule[part] && date>=new Date(i.schedule[part].dueAt))) fail(409);
    await tx.query("INSERT INTO installment_extensions(invoice_id,part,due_at,approved_by,reason) VALUES ($1,$2,$3,$4,$5)",
      [id,part,date,actor.id,reason]);
    return invoiceFor(tx,actor,id,false,true);
  }));
  app.get("/api/v1/payments/overdue",req=>authorized(req,async(tx,actor)=>{
    if (!actor.verifier && !actor.plan_approver) fail(403);
    return (await tx.query(summary+" WHERE b.next_due<now() ORDER BY b.next_due,i.id LIMIT 100")).rows;
  }));
  app.get<{Params:{id:string}}>("/api/v1/invoices/:id/receipts",{schema:{params}},req=>authorized(req,async(tx,actor)=>{
    await invoiceFor(tx,actor,req.params.id);
    return (await tx.query(`SELECT receipt_id,part,amount_paisa,verified_at,transferred_at,transfer_reference,enrollment_id
      FROM payment_receipts WHERE invoice_id=$1 ORDER BY part`,[req.params.id])).rows;
  }));
  app.get("/api/v1/payments/review",req => authorized(req,async (tx,actor) => {
    if (!actor.verifier) fail(403);
    return (await tx.query(summary + " WHERE p.revision IS NOT NULL AND p.correction IS NULL AND r.revision IS DISTINCT FROM p.revision AND b.balance_paisa>0 ORDER BY review_due,i.id LIMIT 100")).rows;
  }));
  app.post<{Params:{id:string};Body:{revision:number;image:string}}>("/api/v1/invoices/:id/proofs", {
    bodyLimit: 4_195_000, schema:{params,body:body({revision,image:{type:"string",minLength:4,maxLength:4_194_304}})},
  },req => authorized(req,async (tx,actor) => {
    const id = req.params.id;
    const i = await invoiceFor(tx,actor,id,true);
    const n = req.body.revision;
    if (i.status === "paid" || i.status === "plan_pending" || n !== i.revision && (n !== (i.revision ?? 0)+1 || i.status === "in_review")) fail(409);
    const raw = Buffer.from(req.body.image,"base64");
    const png = raw.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    if (!png && (raw[0] !== 255 || raw[1] !== 216 || raw[2] !== 255)) fail(400);
    const image = await sharp(raw,{limitInputPixels:16_000_000}).rotate().resize({width:2048,height:2048,fit:"inside",withoutEnlargement:true})
      .jpeg({quality:85}).toBuffer().catch(() => fail(400));
    if (image.length>3145728) fail(413);
    if (n === i.revision) {
      const same = await tx.query("SELECT 1 FROM payment_proofs WHERE invoice_id=$1 AND revision=$2 AND submitted_by=$3 AND screenshot=$4",[id,n,actor.id,image]);
      if (!same.rowCount) fail(409);
    } else {
      await tx.query("INSERT INTO payment_proofs(invoice_id,revision,submitted_by,screenshot) VALUES ($1,$2,$3,$4)",[id,n,actor.id,image]);
    }
    return {invoiceId:id,revision:n};
  }));
  app.get<{Params:{id:string}}>("/api/v1/invoices/:id/proof",{schema:{params}},async (req,reply) => {
    const image = await authorized(req,async (tx,actor) => {
      const i = await invoiceFor(tx,actor,req.params.id);
      if (!i.revision) fail(404);
      return (await tx.query("SELECT screenshot FROM payment_proofs WHERE invoice_id=$1 AND revision=$2",[i.id,i.revision])).rows[0].screenshot;
    });
    return reply.type("image/jpeg").send(image);
  });
  app.post<{Params:{id:string};Body:{revision:number;reason:string}}>("/api/v1/invoices/:id/correction",{
    schema:{params,body:body({revision,reason:{type:"string",minLength:1,maxLength:1000,pattern:"\\S"}})},
  },req => authorized(req,async (tx,actor) => {
    if (!actor.verifier) fail(403);
    const { id } = req.params;
    await lock(tx,id.toLowerCase(),2);
    const result = await tx.query(`UPDATE payment_proofs p SET correction=$3,reviewed_by=$4,reviewed_at=clock_timestamp()
      FROM payment_invoices i WHERE p.invoice_id=i.id AND i.id=$1 AND p.revision=$2 AND p.correction IS NULL
      AND i.student_id<>$4 AND i.created_by<>$4 AND NOT EXISTS (SELECT FROM payment_proofs WHERE invoice_id=i.id AND submitted_by=$4)
      AND NOT EXISTS (SELECT FROM payment_receipts WHERE invoice_id=i.id AND revision=p.revision)`,[id,req.body.revision,req.body.reason,actor.id]);
    if (!result.rowCount) fail(409);
    return { status:"correction" };
  }));
  app.post<{Params:{id:string};Body:{revision:number;amountPaisa:number;reference:string;transferredAt:string}}>("/api/v1/invoices/:id/verify",{
    schema:{params,body:body({revision,amountPaisa:{type:"integer",minimum:1,maximum:2147483647},
      reference:{type:"string",pattern:"^[A-Za-z0-9][A-Za-z0-9/-]{2,79}$"},transferredAt:{type:"string",format:"date-time"}})},
  },req => authorized(req,async (tx,actor) => {
    if (!actor.verifier) fail(403);
    const {revision,amountPaisa,reference,transferredAt} = req.body;
    await tx.query("SELECT approve_transfer($1,$2,$3,$4,$5,$6)",[actor.session,req.params.id,revision,amountPaisa,reference,transferredAt]);
    return invoiceFor(tx,actor,req.params.id);
  }));
}
