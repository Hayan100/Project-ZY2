import type { FastifyInstance } from "fastify";
import { fail } from "./authorized.ts";
import { allowed, label, moderator, obj, params, uuid, type Path, type Session } from "./community.ts";

const publicStatus = "status NOT IN ('submitted','declined')";
const statuses = ["under_review","planned","in_progress","delivered","declined"];
type Submission = {id:string; title:string; description:string};
type Page = {Querystring:{after?:string}};

export function registerFeatureBoard(app: FastifyInstance, session: Session) {
  const board = "/api/v1/feature-suggestions";
  const staff = "/api/v1/staff/feature-suggestions";
  for (const staffView of [false,true]) {
    app.get<Page>(staffView ? staff : board, {schema:{querystring:obj({after:uuid},[])}}, req =>
      session(req, async (tx, actor) => {
        if (staffView) await moderator(tx,actor.id);
        else await allowed(tx,actor.id);
        const {rows} = await tx.query(`SELECT s.id,s.title,s.description,s.status,s.version,
          s.author=$1 AS mine,(SELECT count(*)::int FROM feature_votes WHERE suggestion=s.id) AS votes,
          EXISTS(SELECT FROM feature_votes WHERE suggestion=s.id AND voter=$1) AS voted
          FROM feature_suggestions s WHERE (${staffView ? "true" : publicStatus+" OR author=$1"})
          AND ($2::uuid IS NULL OR s.id>$2) ORDER BY s.id LIMIT 51`, [actor.id,req.query.after]);
        const suggestions = rows.slice(0,50);
        return {suggestions,next:rows.length>50 ? suggestions[49].id : null};
      }));
  }
  app.post<{Body:Submission}>(board, {schema:{body:obj({id:uuid,title:label(160),description:label(3000)})}},
    req => session(req, async (tx,actor) => {
      await allowed(tx,actor.id,true);
      const {id,title,description} = req.body;
      const args = [id,actor.id,title,description];
      await tx.query(`INSERT INTO feature_suggestions(id,author,title,description) VALUES($1,$2,$3,$4)
        ON CONFLICT (id) DO NOTHING`,args);
      return (await tx.query(`SELECT id,status,version FROM feature_suggestions
        WHERE (id,author,title,description)=($1,$2,$3,$4)`,args)).rows[0] ?? fail(409);
    }));
  app.put<Path & {Body:{voted:boolean}}>(board+"/:id/vote", {schema:{params,body:obj({voted:{type:"boolean"}})}},
    req => session(req, async (tx,actor) => {
      await allowed(tx,actor.id,true);
      const id = req.params.id;
      if (!(await tx.query(`SELECT FROM feature_suggestions WHERE id=$1 AND ${publicStatus} FOR SHARE`,[id])).rowCount) fail(404);
      if (req.body.voted) await tx.query("INSERT INTO feature_votes(suggestion,voter) VALUES($1,$2) ON CONFLICT DO NOTHING",[id,actor.id]);
      else await tx.query("DELETE FROM feature_votes WHERE suggestion=$1 AND voter=$2",[id,actor.id]);
      return {id,voted:req.body.voted};
    }));
  app.put<Path & {Body:{status:string;version:number}}>(staff+"/:id/status", {schema:{params,body:obj({
    status:{enum:statuses},version:{type:"integer",minimum:0,maximum:2147483646}
  })}}, req => session(req, async (tx,actor) => {
    await moderator(tx,actor.id);
    const {status,version} = req.body;
    const {id} = req.params;
    const row = (await tx.query("SELECT status,version,reviewed_by FROM feature_suggestions WHERE id=$1 FOR UPDATE",[id])).rows[0] ?? fail(404);
    if (row.status===status && row.reviewed_by===actor.id && row.version===version+1) return {id,status,version:row.version};
    if (row.version!==version) fail(409);
    return (await tx.query(`UPDATE feature_suggestions SET status=$2,version=version+1,reviewed_by=$3
      WHERE id=$1 RETURNING id,status,version`,[id,status,actor.id])).rows[0];
  }));
}
