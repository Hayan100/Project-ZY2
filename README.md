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

## Checkout and manual bank transfers

Apply migrations, then run `psql -v ON_ERROR_STOP=1 -f payment-grants.sql` from `backend/` as database owner against the migrated database. The runtime login can execute the verification routine. Only the owner configures staff permissions, batches and offers. Give sales staff the `sales` permission and payment reviewers the `verifier` permission in `payment_permissions`; both reference an existing staff membership. Use a dedicated database where untrusted roles cannot create objects in the public schema.

An offer is an immutable version of a product price (PKR paisa), receiving-account identifier, bank instructions, policy text/version, support contact, review target and access dates. Use the same canonical receiving-account identifier across offers for the same bank account. Configure either duration in days after approval or fixed dates. A fixed-date offer can reference a capacity-limited batch. Disable an offer to stop new invoices. Create actual offers using approved terms and bank details in the deployment database.

1. Open `GET /api/v1/checkout/:offerId` from the product or registration journey. Keep this URL as the resume destination. For `authenticate`, submit the returned `checkoutOfferId` with email sign-in, sign-up, verification resend or Google sign-in. The API builds the same-origin callback. The verification link signs the new student in and returns to their offer. Email login returns the URL to follow; Google redirects back through the provider callback. For `resume_invoice`, open the existing invoice. For `confirm_invoice`, show the returned price, dates and policy for confirmation.
2. Google setup uses `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Register `AUTH_ORIGIN/api/auth/callback/google` as the redirect URI. When checkout returns `googleAvailable`, offer `POST /api/auth/sign-in/social` with `provider: "google"` and the checkout offer ID; follow the authorization URL. No credentials are stored in Git.
3. Create an invoice via `POST /api/v1/invoices` with a client-generated UUID `id` (reuse on retry), `offerId` and accepted `policyVersion`. The signed-in account owns the invoice. Authorized sales can include `studentId` for assisted enrollment. Conflicting access, an existing open invoice, unavailable seats or changed terms return 409. Resolve overlaps before issuing a payable offer. A student can assign an existing invoice to a sales representative via `POST /api/v1/invoices/:id/assign-sales` with `staffId`.
4. The student transfers the fee to the account on the invoice. The owner or assigned/creating sales representative posts `{revision, image}` to `/api/v1/invoices/:id/proofs`. Start at revision 1. Send base64 PNG/JPEG without a data-URL prefix (up to 3 MiB decoded). The API validates and re-encodes screenshots as private JPEGs. Read status, due time, support contact and correction reason at `GET /api/v1/invoices/:id`; the current image is at `GET /api/v1/invoices/:id/proof`.
5. Reviewers get the oldest 100 outstanding proofs at `GET /api/v1/payments/review`. Compare the proof with the receiving account's actual transaction record. Request a correction via `POST /api/v1/invoices/:id/correction` with `revision` and `reason`; corrected proof increments the revision. To approve, post `revision`, `amountPaisa`, bank `reference` and bank-confirmed ISO `transferredAt` to `/api/v1/invoices/:id/verify`. The beneficiary, invoice creator and anyone who uploaded proof cannot approve it.
6. The paid invoice is the receipt, identified by its invoice UUID, with the amount, reference, verification time and enrollment ID. Approval records the receipt, grants access and books any seat in one transaction. A verified transfer made before sellout can receive an extra seat, recorded on its receipt. Identical approval retries reuse the receipt. A reference cannot settle two invoices for the same receiving account.

This API handles full-fee offers. Individually negotiated installment schedules, operator overlap resolution, and email/WhatsApp receipt delivery are separate workflows. The review queue exposes deadlines for overdue follow-up.
