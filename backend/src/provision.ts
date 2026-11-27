import { randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { hashPassword } from "better-auth/crypto";
import { Pool } from "pg";
import { mailer } from "./identity.ts";

// Operator command. Deliver credentials only to an independently verified address.
const { values: { email, name, staff } } = parseArgs({ options: {
  email: { type: "string" }, name: { type: "string" }, staff: { type: "boolean" },
} });
if (!email || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email) || !name?.trim() || !process.env.DATABASE_URL) {
  throw new Error("Provide --email, --name and an operator DATABASE_URL");
}
const send = mailer();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  const id = randomUUID();
  const temporary = randomBytes(24).toString("base64url");
  const hash = await hashPassword(temporary);
  await client.query("BEGIN");
  await client.query('INSERT INTO "user"(id,email,name,"emailVerified") VALUES ($1,$2,$3,true)', [id,email.toLowerCase(),name]);
  await client.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES ($1,$2,$3,$2,$4)', [randomUUID(),id,"credential",hash]);
  await client.query("INSERT INTO temporary_credentials VALUES ($1,now() + interval '24 hours')", [id]);
  if (staff) await client.query("INSERT INTO staff_members VALUES ($1)", [id]);
  await send(email, "Activate your Project-ZY2 account", "Sign in within 24 hours and choose a new password. Temporary password: " + temporary);
  await client.query("COMMIT");
} catch {
  await client.query("ROLLBACK");
  throw new Error("Provisioning failed. Check the mailbox configuration and whether the account already exists.");
} finally {
  client.release();
  await pool.end();
}
