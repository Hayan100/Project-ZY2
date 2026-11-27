import { registerCurriculum } from "./curriculum.ts";
import { registerPayments } from "./payments.ts";
import { betterAuth } from "better-auth";
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import nodemailer from "nodemailer";

export function mailer() {
  const url = process.env.SMTP_URL;
  const from = process.env.MAIL_FROM;
  if (!url?.startsWith("smtps://") || !from) throw new Error("Set an smtps:// SMTP_URL and MAIL_FROM");
  const transport = nodemailer.createTransport(url);
  return async (to: string, subject: string, text: string) => {
    await transport.sendMail({ from, to, subject, text });
  };
}

export function registerIdentity(app: FastifyInstance, db: Pool, baseURL: string, secret: string,
  send: (to: string, subject: string, text: string) => Promise<void>) {
  const origin = new URL(baseURL).origin;
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!origin.startsWith("https://") && !(local && process.env.NODE_ENV !== "production")) throw new Error("HTTPS required");
  if (secret.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters");
  const googleId = process.env.GOOGLE_CLIENT_ID;
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (Boolean(googleId) !== Boolean(googleSecret)) throw new Error("Set both Google OAuth credentials");
  const google = googleId && googleSecret ? { clientId: googleId, clientSecret: googleSecret } : undefined;
  const auth = betterAuth({
    socialProviders: google ? { google } : {},
    account: { encryptOAuthTokens: true, accountLinking: { requireLocalEmailVerified: true } },
    baseURL: origin, secret, database: db, appName: "Project-ZY2",
    emailAndPassword: { enabled: true, requireEmailVerification: true, minPasswordLength: 12 },
    emailVerification: { sendOnSignUp: true, autoSignInAfterVerification: true, sendVerificationEmail: async ({ user, url }) => {
      await send(user.email, "Verify your Project-ZY2 email", "If you registered, verify your address:\n" + url);
    } },
    advanced: { ipAddress: { ipAddressHeaders: ["x-client-ip"] } },
    rateLimit: { enabled: true, storage: "database" },
    session: { disableSessionRefresh: true, cookieCache: { enabled: false } },
  });
  for (const route of ["sign-up/email", "sign-in/email", "verify-email", "send-verification-email", "sign-out", "change-password", ...(google ? ["sign-in/social", "callback/google"] : [])]) {
    app.route({ method: (route === "verify-email" || route === "callback/google") ? "GET" : "POST", url: "/api/auth/" + route,
      handler: async (req, reply) => {
        const headers = new Headers({ "x-client-ip": req.ip });
        for (const key of ["cookie", "origin", "sec-fetch-site", "user-agent", "content-type"]) {
          const value = req.headers[key];
          if (typeof value === "string") headers.set(key, value);
        }
        if (req.method === "POST" && ((req.headers.origin && req.headers.origin !== origin) ||
            req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")) return reply.code(403).send();
        const body = req.body as Record<string, unknown> | undefined;
        if (body?.checkoutOfferId !== undefined) {
          if (typeof body.checkoutOfferId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(body.checkoutOfferId)) return reply.code(400).send();
          const resume = origin + "/api/v1/checkout/" + body.checkoutOfferId;
          body.callbackURL = resume;
          body.newUserCallbackURL = resume;
          body.errorCallbackURL = resume;
          delete body.checkoutOfferId;
        }
        if (route === "change-password" && typeof body?.currentPassword === "string" && typeof body.newPassword === "string" &&
            body.currentPassword.normalize("NFKC") === body.newPassword.normalize("NFKC")) {
          return reply.code(400).send({ error: "Choose a different password" });
        }
        const response = await auth.handler(new Request(origin + req.url, {
          method: req.method, headers, body: req.method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        }));
        for (const key of ["content-type", "location", "retry-after"]) {
          const value = response.headers.get(key);
          if (value) reply.header(key, value);
        }
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header("set-cookie", cookies);
        return reply.code(response.status).send(await response.text());
      },
    });
  }
  function principal(cookie: string | undefined) {
    return auth.api.getSession({ headers: new Headers(cookie ? { cookie } : {}) });
  }
  registerCurriculum(app, db, principal, origin);
  registerPayments(app, db, principal, origin, Boolean(google));
  app.get("/api/v1/me", async (req, reply) => {
    const identity = await principal(req.headers.cookie);
    if (!identity) return reply.code(401).send();
    const { rows } = await db.query(`
      SELECT EXISTS(SELECT FROM staff_members WHERE user_id = s."userId") AS staff,
             EXISTS(SELECT FROM temporary_credentials WHERE user_id = s."userId") AS "mustChangePassword"
      FROM session s WHERE id = $1 AND "expiresAt" > now()`, [identity.session.id]);
    if (!rows.length) return reply.code(401).send();
    return { id: identity.user.id, role: rows[0].staff ? "staff" : "student", mustChangePassword: rows[0].mustChangePassword };
  });
  app.get<{ Params: { product: string } }>("/api/v1/access/:product", async (req, reply) => {
    const identity = await principal(req.headers.cookie);
    if (!identity) return reply.code(401).send();
    const { rows } = await db.query(`
      SELECT EXISTS (
        SELECT FROM enrollments e WHERE e.user_id = s."userId" AND e.product_key = $2
        AND e.revoked_at IS NULL AND e.starts_at <= now() AND now() < e.ends_at
        AND NOT EXISTS (SELECT FROM temporary_credentials WHERE user_id = e.user_id)
      ) AS allowed FROM session s WHERE s.id = $1 AND s."expiresAt" > now()`, [identity.session.id, req.params.product]);
    if (!rows.length) return reply.code(401).send();
    return rows[0].allowed ? { allowed: true } : reply.code(403).send();
  });
}
