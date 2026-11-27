import type { FastifyInstance } from "fastify";
import { fail } from "./authorized.ts";
import { label, obj, params, uuid, type Path, type Session } from "./community.ts";

const categories = ["access_payment", "technical", "service_complaint"];
const actions = ["reply", "claim", "escalate", "resolve", "reopen"];
type Ticket = { id: string; category: string; subject: string; description: string; reportedStaff?: string };
type Event = { version: number; action: string; message: string };
const fields = "t.id,t.category,t.subject,t.resolved,t.escalated,t.version,t.updated_at";

export function registerSupport(app: FastifyInstance, session: Session) {
  const root = "/api/v1/support/tickets";
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
      tickets: (await tx.query(`SELECT ${fields},t.assignee FROM support_tickets t WHERE ${scope}
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
