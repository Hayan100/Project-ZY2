# Project-ZY2

The API uses TypeScript, Fastify, PostgreSQL and Better Auth. Run commands from `backend/` with Node 24.6+.

## Database and runtime

Run `npm ci`. Set `DATABASE_URL` to the migration owner of a dedicated PostgreSQL database and run `npm run migrate`. Provision a separate runtime login in psql:

```sql
CREATE ROLE zy2_api LOGIN;
\password zy2_api
GRANT USAGE ON SCHEMA public TO zy2_api;
GRANT SELECT ON public_programs, staff_members, temporary_credentials, enrollments TO zy2_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON "user", account, session, verification, "rateLimit" TO zy2_api;
```

Start with the limited runtime connection in `DATABASE_URL`. Set `AUTH_ORIGIN` to the exact HTTPS origin (loopback HTTP is allowed in development), `AUTH_SECRET` to a persistent cryptographically random secret of at least 32 bytes, and `SMTP_URL` (smtps://) and `MAIL_FROM` for verification and activation mail. Keep secrets outside Git. Use certificate-verified TLS for remote database connections. Run `npm start`; the default listener is 127.0.0.1:3000. Rate limits use the socket peer address. Behind a reverse proxy, configure trusted proxy addresses before rollout so users have individual limits. Exclude auth query strings from proxy logs.

## API

| Route | Behavior |
| --- | --- |
| GET /health/live | Process liveness |
| GET /api/v1/programs | Public catalog, cached 60 seconds per process with concurrent misses coalesced |
| POST /api/auth/sign-up/email | Student self-registration with name, email and password. Verification email sent |
| GET /api/auth/verify-email | Follow the emailed verification link |
| POST /api/auth/send-verification-email | Resend a verification link |
| POST /api/auth/sign-in/email | Verified email and password. Replaces the previous session |
| GET /api/v1/me | Signed-in identity, staff/student role and mandatory password change status |
| POST /api/auth/change-password | Supply currentPassword and newPassword. Previous session is revoked |
| POST /api/auth/sign-out | End current session |
| GET /api/v1/access/:product | 200 for a currently effective grant, 401 for an invalid session, 403 otherwise |

Use same-origin JSON requests and the HTTP-only session cookie. Access checks read current PostgreSQL state and return no-store responses. Staff use the same login and receive no automatic product access. Only an authorized enrollment workflow should issue a grant, scoped to the purchased product and effective dates. Payment evidence, unpaid orders and account creation alone grant nothing. Future protected content handlers must enforce authorization server-side for the actual resource.

## Operator-created accounts

With an authorized operator database connection and a verified destination address, run `node src/provision.ts --email student@example.org --name "Student Name"`. Add `--staff` only for authorized staff. The command emails a random temporary password, valid for 24 hours. A first login is restricted to account status and replacing the password. An existing email causes provisioning to fail. There is no public role assignment endpoint.

Run `npm run check` and `npm test`. For the database integration test, set `TEST_DATABASE_URL` to a migrated disposable database using an owner connection and create the limited role above. The test exercises the API under that role.
