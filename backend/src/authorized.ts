import type { FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";

export type Identity = (cookie?: string) => Promise<{ session: { id: string }; user: { id: string; emailVerified: boolean } } | null>;
export type SessionActor = { id: string; session: string };
export function fail(statusCode: number): never {
  throw Object.assign(new Error("Request declined"), { statusCode });
}

export function sessionTransaction(db: Pool, principal: Identity, origin: string) {
  return async function authorized<T>(req: FastifyRequest, work: (tx: PoolClient, actor: SessionActor) => Promise<T>) {
    if (req.method !== "GET" && ((req.headers.origin && req.headers.origin !== origin) ||
        req.headers["sec-fetch-site"] === "cross-site")) fail(403);
    const identity = await principal(req.headers.cookie);
    if (!identity) return fail(401);
    if (!identity.user.emailVerified) return fail(403);
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      const { rows } = await tx.query(`SELECT s."userId" AS id,s.id AS session FROM session s
        WHERE s.id=$1 AND s."expiresAt">clock_timestamp() AND NOT EXISTS
        (SELECT FROM temporary_credentials WHERE user_id=s."userId") FOR SHARE OF s`, [identity.session.id]);
      if (!rows.length) fail(403);
      const result = await work(tx, rows[0]);
      await tx.query("COMMIT");
      return result;
    } catch (error) {
      await tx.query("ROLLBACK");
      const code = (error as { code?: string }).code;
      if (code === "P0409" || code === "23505") fail(409);
      if (code === "42501") fail(403);
      if (code === "P0002") fail(404);
      throw error;
    } finally { tx.release(); }
  }
}
