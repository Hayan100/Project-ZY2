import type { FastifyInstance } from "fastify";
import { fail } from "./authorized.ts";
import { label, obj, params, uuid, type Path, type Session } from "./community.ts";

const categories = ["access_payment", "technical", "service_complaint"];
const actions = ["reply", "claim", "escalate", "resolve", "reopen"];
type Ticket = { id: string; category: string; subject: string; description: string; reportedStaff?: string };
type Event = { version: number; action: string; message: string };
const fields = "t.id,t.category,t.subject,t.resolved,t.escalated,t.version,t.updated_at";
const guidance = [
  {category:"access_payment", title:"My payment is under review", text:"Open your invoice to check the review status. If staff request a correction, submit the corrected proof on that invoice. Include the invoice ID in a private ticket if you need help."},
  {category:"access_payment", title:"I cannot open a paid course", text:"Sign in with the account used for the purchase and check the product and access dates. If access is still missing, open a payment or access ticket with the course name."},
  {category:"technical", title:"A page or reader will not load", text:"Reopen the page while online. If it still fails, include the page name, device, and error message in a technical ticket. Keep passwords and sign-in links private."},
  {category:"service_complaint", title:"Report a service complaint privately", text:"Open a service complaint ticket. You can identify the staff member involved. Designated senior reviewers handle complaints, and the reported staff member cannot open your ticket."},
];

export function registerSupport(app: FastifyInstance, session: Session) {
  const root = "/api/v1/support/tickets";
  app.post<{Body:{category:string;ackMinutes:number;resolveMinutes:number}}>("/api/v1/staff/support/targets",{schema:{body:obj({
    category:{enum:categories},ackMinutes:{type:"integer",minimum:1,maximum:525600},resolveMinutes:{type:"integer",minimum:1,maximum:525600}
  })}},req=>session(req,async(tx,a)=>{
    const b=req.body;
    if(!(await tx.query("SELECT FROM support_reviewers WHERE reviewer=$1 AND category=$2 AND senior",[a.id,b.category])).rowCount) fail(403);
    if(b.resolveMinutes<b.ackMinutes) fail(422);
    await tx.query(`INSERT INTO support_targets VALUES ($1,$2,$3) ON CONFLICT(category) DO UPDATE
      SET ack_minutes=excluded.ack_minutes,resolve_minutes=excluded.resolve_minutes`,[b.category,b.ackMinutes,b.resolveMinutes]);
    return b;
  }));
  app.get<{Querystring:{q?:string;category?:string}}>("/api/v1/support/help", {schema:{querystring:obj({
    q:label(120), category:{enum:categories}
  },[])}}, req => session(req, async () => {
    const terms = (req.query.q ?? "").trim().toLowerCase().split(/\s+/);
    const articles = guidance.filter(article => {
      const text = (article.title+" "+article.text).toLowerCase();
      return (!req.query.category || article.category===req.query.category) && terms.every(term=>text.includes(term));
    });
    return {articles,tickets:root};
  }));
  app.post<{Body: Ticket}>(root, { schema: { body: obj({
    id: uuid, category: {enum: categories}, subject: label(160), description: label(3000), reportedStaff: label(200)
  }, ["id","category","subject","description"]) } }, req => session(req, async (tx, actor) => {
    const {id, category, subject, description, reportedStaff} = req.body;
    if (reportedStaff && (category !== "service_complaint" ||
      !(await tx.query("SELECT FROM staff_members WHERE user_id=$1", [reportedStaff])).rowCount)) fail(422);
    const args = [id, actor.id, category, subject, description, reportedStaff ?? null];
    await tx.query(`INSERT INTO support_tickets(id,student,category,subject,description,reported_staff)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`, args);
    if (!(await tx.query(`SELECT FROM support_tickets WHERE (id,student,category,subject,description)=($1,$2,$3,$4,$5)
      AND reported_staff IS NOT DISTINCT FROM $6`, args)).rowCount) fail(409);
    return {id};
  }));

  for (const staff of [false, true]) {
    const path = staff ? "/api/v1/staff/support/tickets" : root;
    const scope = staff ? `t.student<>$1 AND t.reported_staff IS DISTINCT FROM $1 AND EXISTS
      (SELECT FROM support_reviewers r WHERE r.reviewer=$1 AND r.category=t.category AND (NOT t.escalated OR r.senior))` : "t.student=$1";
    app.get(path, req => session(req, async (tx, actor) => ({
      tickets: (await tx.query(`SELECT ${fields},t.assignee,
        (t.opened_at+g.ack_minutes*interval '1 minute') AS "ackDue",
        (t.opened_at+g.resolve_minutes*interval '1 minute') AS "resolutionDue",
        NOT t.resolved AND (now()>t.opened_at+g.resolve_minutes*interval '1 minute' OR
          (now()>t.opened_at+g.ack_minutes*interval '1 minute' AND NOT EXISTS(SELECT FROM support_events h
            WHERE h.ticket=t.id AND h.actor<>t.student))) IS TRUE AS overdue
        FROM support_tickets t LEFT JOIN support_targets g ON g.category=t.category WHERE ${scope}
        ORDER BY t.resolved,t.updated_at DESC,t.id`, [actor.id])).rows
    })));
    app.get<Path>(path + "/:id", {schema: {params}}, req => session(req, async (tx, actor) => {
      const ticket = (await tx.query(`SELECT ${fields},t.description,t.assignee,t.reported_staff,t.student
        FROM support_tickets t WHERE ${scope} AND id=$2 FOR SHARE`, [actor.id, req.params.id])).rows[0] ?? fail(404);
      const events = (await tx.query("SELECT version,actor,action,message,created_at FROM support_events WHERE ticket=$1 ORDER BY version", [ticket.id])).rows;
      return {...ticket, events};
    }));
    app.post<Path & {Body: Event}>(path + "/:id/events", {schema: {params, body: obj({
      version: {type:"integer", minimum:0, maximum:2147483646},
      action: {enum: staff ? actions : ["reply","reopen"]}, message: label(3000)
    })}}, req => session(req, async (tx, actor) => {
      const id = req.params.id;
      const {version, action, message} = req.body;
      const ticket = (await tx.query(`SELECT t.* FROM support_tickets t WHERE ${scope} AND id=$2 FOR UPDATE`, [actor.id,id])).rows[0] ?? fail(404);
      if (version !== ticket.version) {
        const prior = await tx.query(`SELECT FROM support_events WHERE ticket=$1 AND version=$2
          AND actor=$3 AND action=$4 AND message=$5`, [id,version+1,actor.id,action,message]);
        if (prior.rowCount) return {id, version:version+1};
        fail(409);
      }
      if (ticket.resolved !== (action === "reopen") || (action === "escalate" && ticket.escalated)) fail(409);
      if (staff && ticket.assignee && ticket.assignee !== actor.id && action !== "claim") fail(409);
      if (action === "escalate" && !(await tx.query(`SELECT FROM support_reviewers WHERE category=$1 AND senior
        AND reviewer NOT IN ($2,$3) AND reviewer IS DISTINCT FROM $4`, [ticket.category,actor.id,ticket.student,ticket.reported_staff])).rowCount) fail(409);
      await tx.query(`UPDATE support_tickets SET version=version+1,updated_at=clock_timestamp(),
        resolved=($2='resolve'),escalated=escalated OR $2='escalate',
        assignee=CASE WHEN $2 IN ('escalate','reopen') THEN NULL WHEN $2='claim' THEN $3 ELSE assignee END
        WHERE id=$1`, [id,action,actor.id]);
      await tx.query("INSERT INTO support_events(ticket,version,actor,action,message) VALUES($1,$2,$3,$4,$5)",
        [id,version+1,actor.id,action,message]);
      return {id, version:version+1};
    }));
  }
}
