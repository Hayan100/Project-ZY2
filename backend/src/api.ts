import Fastify from "fastify";
import helmet from "@fastify/helmet";
import { LRUCache } from "lru-cache";

export type Program = { code: string; name: string };

export function buildApi(readPublished: () => Promise<Program[]>, logger = false, checkDatabase: () => Promise<unknown> = readPublished) {
  const app = Fastify({
    logger: logger && { serializers: { req: (req: { method: string }) => ({ method: req.method }) } },
    bodyLimit: 16_384, requestTimeout: 60_000, trustProxy: false,
    onProtoPoisoning: "error", onConstructorPoisoning: "error",
  });
  app.register(helmet);

  // Each process refreshes independently. Publishing changes appear within 60 seconds.
  const catalog = new LRUCache<string, Program[]>({
    max: 1, ttl: 60_000, allowStale: false,
    fetchMethod: readPublished,
  });

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    await checkDatabase();
    return { status: "ready" };
  });
  app.get("/api/v1/programs", async (_request, reply) => {
    const programs = await catalog.fetch("public");
    // Downstream caches revalidate so their TTL cannot extend the publishing delay.
    reply.header("Cache-Control", "public, max-age=0, must-revalidate");
    return { programs };
  });
  app.setErrorHandler((error, request, reply) => {
    const status = typeof error === "object" && error && "statusCode" in error
      ? Number(error.statusCode) : 500;
    if (status === 409) return reply.code(status).send({ error: "Request conflicts with current state", code: "conflict" });
    if (status === 422) return reply.code(status).send({ error: "Request failed validation", code: "validation_failed" });
    if (status >= 400 && status < 500) return reply.code(status).send({ error: "Invalid request" });
    request.log.error({ requestId: request.id }, "Request failed");
    return reply.code(503).send({ error: "Service unavailable" });
  });
  return app;
}
