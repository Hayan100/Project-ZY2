import { registerCommunity } from "./community.ts";
import { registerInventory } from "./inventory.ts";
import { registerSupport } from "./support.ts";
import { registerFeatureBoard } from "./feature-board.ts";
import { registerLive } from "./live.ts";
import { registerFamilies } from "./family.ts";
import { registerWelcome } from "./welcome.ts";
import { registerPlanner } from "./planner.ts";
import { registerFlashcards } from "./flashcards.ts";
import { registerQuizzes } from "./quizzes.ts";
import { registerEbooks } from "./ebooks.ts";
import { registerLearning } from "./learning.ts";
import { registerCourses } from "./curriculum.ts";
import { registerSaved } from "./saved.ts";
import { registerLibrary } from "./virtual-library.ts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { fail, sessionTransaction, type Identity } from "./authorized.ts";

export function registerRoutes(app: FastifyInstance, db: Pool, principal: Identity, origin: string) {
  const session = sessionTransaction(db, principal, origin);
  function academic<T>(req: FastifyRequest, work: (tx: PoolClient, author: string) => Promise<T>) {
    return session(req, async (tx, actor) => {
      if (!(await tx.query("SELECT FROM academic_staff WHERE user_id=$1", [actor.id])).rowCount) fail(403);
      return work(tx, actor.id);
    });
  }
  const accessible = `FROM courses c JOIN course_revisions r ON (c.id,c.published_revision)=(r.course_id,r.revision)
    WHERE EXISTS (SELECT FROM enrollments e WHERE e.user_id=$1 AND e.product_key=c.product_key
      AND e.revoked_at IS NULL AND e.starts_at<=now() AND now()<e.ends_at)`;
  registerCourses(app, session, academic, accessible);
  registerLibrary(app, session, accessible);
  registerLearning(app, session, accessible);
  const bookFor = registerEbooks(app, session, academic, accessible);
  registerQuizzes(app, session, academic, accessible);
  const revisionSummary = registerFlashcards(app, session, academic, accessible);
  registerWelcome(app, session, revisionSummary);
  registerFamilies(app, session);
  registerLive(app, session, academic);
  const visibleChannels = registerCommunity(app, session, accessible);
  const savedCommunity = registerInventory(app, session, academic, accessible, visibleChannels);
  registerSaved(app, session, accessible, bookFor, savedCommunity);
  registerSupport(app, session);
  registerFeatureBoard(app, session);
  registerPlanner(app, session, academic, accessible, revisionSummary);
}
