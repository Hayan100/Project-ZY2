import { registerIdentity, mailer } from "./identity.ts";
import { Pool } from "pg";
import { buildApi, type Program } from "./api.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 3000, statement_timeout: 3000 });
const app = buildApi(async () => {
  const result = await db.query<Program>("SELECT code, name FROM public.public_programs ORDER BY code");
  return result.rows;
}, true, () => db.query("SELECT code FROM public.public_programs LIMIT 0"));
registerIdentity(app, db, process.env.AUTH_ORIGIN ?? "", process.env.AUTH_SECRET ?? "", mailer());
db.on("error", () => app.log.error("Idle PostgreSQL connection failed"));
app.addHook("onClose", () => db.end());
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void app.close());
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3000) });
