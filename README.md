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

Full-fee purchases retain the existing workflow. Installment exceptions and receipt dispatch use the same invoice and verification endpoints.

## Individually approved installments

Grant `payment_permissions.plan_approver` to designated staff. Sales, plan approval and transfer verification are independent permissions. A signed-in student requests agreed terms before submitting the first proof via `POST /api/v1/invoices/:id/installments/request`. Send an ordered `schedule` of 2–48 objects with positive integer `amountPaisa` and ISO `dueAt`. Amounts must total the invoice exactly. The student can revise or withdraw a pending request via `/installments/withdraw`. Reviewers list pending requests at `GET /api/v1/payments/installment-requests` and POST the exact reviewed schedule to `/installments/approve`. The database records agreement and approval separately.

Each bank transfer has its own screenshot revision, bank reference and verification. Use the existing proof and verify endpoints for each installment in order. The first verified installment activates access according to the offer dates and books the seat. Later transfers reuse that enrollment. Invoice status becomes paid when the balance reaches zero. The invoice includes the schedule, total paid, outstanding balance and next due date. `GET /api/v1/invoices/:id/receipts` returns each verified transfer and its receipt ID.

Overdue installments appear at `GET /api/v1/payments/overdue`. The worker queues one email reminder per overdue installment. Staff can extend the current installment via `POST /api/v1/invoices/:id/installments/extend` with `part`, `dueAt` and `reason`. The extension records the reviewer and preserves the original schedule. An overdue balance leaves enrollment access in place until its ordinary expiry or a separate authorized decision.

## Delivering receipts

Every newly verified transfer queues one email and one WhatsApp receipt in the payment transaction. Existing receipts retain their identifiers through migration. Previous payments are not bulk-mailed. Transactional receipts use the verified account email. To opt in to WhatsApp receipts, the student posts their E.164 `whatsapp` number to `/api/v1/me/receipt-whatsapp`. After checking ownership through the support channel, authorized payment staff posts the exact `studentId` and `whatsapp` to `/api/v1/payments/verify-whatsapp`. Changing the number requires a fresh check. DELETE on the student's contact endpoint withdraws consent.

1. Run migrations and reapply `backend/payment-grants.sql`. Create a separate `zy2_delivery` login with a strong password and apply `backend/delivery-grants.sql` as owner. Set the worker's `DELIVERY_DATABASE_URL` to that login.
2. Supply the HTTPS `AUTH_ORIGIN`, `SMTP_URL` and `MAIL_FROM`. For WhatsApp, configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (registered E.164 sender), and `TWILIO_RECEIPT_CONTENT_SID` (approved utility template). Its five variables are receipt ID, product, paid PKR amount, payment number and private invoice link. Include the instruction to sign in with the student account. Keep credentials in the deployment secret store.
3. Run `npm run receipts` from `backend/` as a continuously supervised worker. Check pending rows and retry counts in `payment_messages` when a contact or provider needs attention. The worker retries channels independently, retains the WhatsApp message SID and checks delivery status. Email completion means SMTP accepted the message. A crash between provider acceptance and database commit can repeat a notification with the same receipt ID; financial records are unaffected.
4. For integration tests, also create the delivery role and apply the delivery grants in the disposable test database. Provider tests simulate responses without messaging external contacts.

## Curriculum authoring and publication

After migrating, apply `backend/curriculum-grants.sql` as database owner, including in the disposable integration database. Assign individual academic authors and publishers by inserting their existing staff user ID into `academic_staff`. This permission covers all course outlines.

| Method and route | Behavior |
| --- | --- |
| POST /api/v1/staff/courses | Create revision 1 with a client-generated course UUID, a fixed enrollment product key, and an outline |
| GET /api/v1/staff/courses | List drafts and published courses with their current and published revision numbers |
| GET /api/v1/staff/courses/:id | Read the latest draft or supply `?revision=2` to inspect a historical revision and its attribution |
| PUT /api/v1/staff/courses/:id | Submit the current `revision` and a complete replacement `outline`. A stale edit returns 409 |
| POST /api/v1/staff/courses/:id/publish | Submit the reviewed `revision`. Publishing switches the whole outline atomically. Repeating the current publication succeeds |
| GET /api/v1/courses | List published course summaries covered by the signed-in account's active product enrollments |
| GET /api/v1/courses/:id | Read the current published outline. An inaccessible or unpublished course returns 404 |

Example creation payload

```json
{
  "id": "a7a2ef24-c42b-4b52-af44-4ca014650c60",
  "productKey": "biology-course",
  "outline": {
    "title": "Biology", "examYear": 2027, "provinces": ["Punjab"],
    "chapters": [{
      "id": "d75380ae-855f-407f-a964-57f0e7555ab5", "title": "Cells",
      "lessons": [{
        "id": "0741bc2f-0ed8-4316-9958-98bc60e4bee9", "title": "Cell structure",
        "type": "video", "resourceId": "df140830-96de-443b-9cf3-279b1315205c"
      }]
    }]
  }
}
```

Array order sets chapter and lesson order. Preserve lowercase UUIDs across edits and reordering. Each lesson uses `video`, `html_article`, `mcq_quiz` or `flashcard_review` and can include `relatedResourceIds` for ebooks or other materials. Resource IDs identify content for its owning service to authorize. Exam year and province are optional applicability metadata. Drafts can be incomplete. Publication requires at least one chapter, at least one lesson in each chapter and a primary resource ID for every lesson.

## Academy lesson delivery

Academic staff can set an optional ISO timestamp with a timezone in `releaseAt` and list prerequisite lesson UUIDs in `prerequisiteIds`. Publication validates that every prerequisite belongs to the outline and that the dependencies have no cycles. Existing outlines remain available on enrollment.

| Route | Behavior |
| --- | --- |
| GET /api/v1/courses/:id | Includes completion counts and `continueLessonId`. Returns the last saved eligible unfinished lesson, or the first eligible unfinished lesson in outline order. Locked entries show the reason and omit resource links. |
| GET /api/v1/courses/:id/lessons/:lessonId | Returns the eligible lesson, published course revision, progress version, saved position and completion. Locked lessons return 403. |
| PUT /api/v1/courses/:id/lessons/:lessonId/progress | Saves the signed-in student's position and self-reported completion after checking enrollment and availability. |

Send the `revision` and `version` returned by opening the lesson, along with `completed` and `position`. A video position accepts integer `videoSeconds`, an article position accepts a stable `pageId`, and any lesson accepts an empty position. A 409 means another save or publication won the race. Reopen the lesson before reconciling changes. Completion persists when a student revisits a lesson. Reordering retains progress. Replacing the underlying resource or changing its type starts separate progress. Self-reported completion records study activity only. It grants no quiz score, replay qualification or flashcard scheduling credit.

Apply migrations and reapply `backend/curriculum-grants.sql` before starting the updated API.

## Ebook authoring and reading

Academic staff use `/api/v1/staff/ebooks`. POST a book UUID, an optional fixed `libraryProductKey`, and a `manuscript` to create revision 1. The manuscript contains a title, exam, subject, and ordered pages. Each page has a stable lowercase UUID, a title, and an ordered `blocks` array. Each block has a `type` of `heading` or `paragraph` and a plain-text `text` field. Clients render these as responsive headings and paragraphs using text nodes.

GET the collection to list books. GET `/:id` to preview the latest manuscript, optionally supplying `?revision=N` for an earlier revision. PUT `/:id` with the current revision and complete manuscript to save an edit. POST `/:id/publish` with the reviewed revision to release it. Each published page requires at least one block. Keep existing page IDs when correcting or reordering pages.

| Student route | Behavior |
| --- | --- |
| GET /api/v1/ebooks | My Books for active library products. Optional `q` matches title, exam or subject. Summaries include the last visited current page and separate visited/studied counts. |
| GET /api/v1/ebooks/:id | Current published table of contents, reading indicators and resume page |
| GET /api/v1/ebooks/:id/pages/:pageId | Read a published page by stable ID |
| GET /api/v1/ebooks/:id/search?q=term | Search current page titles and authored text, returning matching page IDs and titles |
| PUT /api/v1/ebooks/:id/pages/:pageId/reading | Record a visit with the current ebook `revision`. Optionally set `studied` to true or false. A stale publication returns 409. |

Inside Academy, append both `courseId` and `lessonId` query parameters to reader, search and reading-progress requests. The published, available lesson must reference that book as its HTML article or a related resource. Without lesson context, reads require an active enrollment for the book's library product. Both paths use the same student/book/page reading record. Course-only books can omit the library product key. Marking a page studied does not complete a lesson.

Apply migrations and reapply `backend/curriculum-grants.sql` to install the ebook runtime permissions.

## Lesson-linked MCQ quizzes

Academic staff use `/api/v1/staff/quizzes`. POST a client-generated quiz UUID in `id` and a `quiz` object containing `title` and ordered `questions`. Each question has a stable `id`, a `stem`, 2–10 options (each with an `id` and `text`), one `correctOptionId`, and a plain-text `explanation`. Use lowercase UUIDs and retain the question ID across corrections or reuse. GET the collection to list quizzes or GET `/:id?revision=N` to preview a revision. PUT the current `revision` and a complete `quiz` to `/:id` to revise it. POST the reviewed `revision` to `/:id/publish`.

Link the published quiz UUID as an MCQ lesson's primary resource or in a lesson's related resources. The student base path is `/api/v1/courses/:courseId/lessons/:lessonId/quizzes/:quizId`. Every route below checks the current enrollment, lesson availability, and link.

| Method and suffix | Behavior |
| --- | --- |
| GET base path | Tutor quiz title, latest published revision, question count and any open attempt ID |
| POST /attempts | Send a fresh UUID in `id`. Reuse it on retry. One student has one open attempt per quiz across all eligible links. If another attempt is open, fetch the base path to resume it. |
| GET /attempts/:attemptId | Resume the signed-in student's pinned revision. Unanswered items show stems and options. After final submission, review includes omitted items. |
| PUT /attempts/:attemptId/answers/:questionId | Send `optionId` to commit the answer and reveal that item's key and explanation. Retrying the same answer is safe. Changing a committed answer returns 409. |
| POST /attempts/:attemptId/submit | Finalize the unranked attempt, record unanswered items as omitted, and return correct, incorrect, omitted and total counts. Safe to retry. |
| GET /coverage | Current quiz's unique used count and per-question latest correctness and omission status across the student's individual lesson quizzes |

Option selection stays local until the student commits. A correct answer earns one point, and incorrect or omitted answers earn zero. A later publication applies to new attempts. A repeat answer updates current correctness and clears omission status while preserving history. Quiz actions preserve the parent lesson's saved video timestamp, reading position and completion state. Reopen the original lesson when leaving practice.

`GET /api/v1/me/quiz-results` returns the student's historical result summaries, including after enrollment expiry. Reading question text or explanations still requires an eligible lesson. Apply migrations and reapply `backend/curriculum-grants.sql` for the new runtime permissions.

## Lesson-linked flashcards and spaced review

Academic staff use `/api/v1/staff/decks`. GET lists decks. GET `/:id` previews the latest draft or a specific `?revision=N`. PUT `/:id` with `{revision,deck:{title,cards}}` to save a draft. Supply revision 0 to create the deck and the current draft revision thereafter. An owned card contains a lowercase UUID, `front` and `back`. Reference an already published academy card in another deck using just its `id`. Its original deck owns the wording.

POST `/:id/publish` with the reviewed revision. The first publication needs at least one card. Publication updates shared wording everywhere and retains each student's schedule. To require relearning, explicitly include the affected owned card IDs in `resetCardIds` when publishing a new revision. The card becomes due immediately for students who previously reviewed it. The publication records the actor and affected cards. All prior ratings remain in history.

Link a published deck as the primary resource of a Flashcard Review lesson or as a related resource. Use `/api/v1/courses/:courseId/lessons/:lessonId/decks/:deckId` to retrieve the recommendation. PUT `/activation` at that path to activate it and GET `/review` for its eligible cards. An assigned mentor can POST `/assign` with `studentId`; the API checks the mentor relationship and the student's current lesson access. Provision authorized pairs in `revision_mentors(student_id,mentor_id)` as database owner. Completing a lesson alone leaves the deck recommended. Review preserves the parent lesson's saved position.

| Student workflow | Route and behavior |
| --- | --- |
| Set daily budget | PUT `/api/v1/me/revision/budget` with `minutes`. New cards become available once the student chooses a budget. An assigned mentor can suggest an adjustment via PUT `/api/v1/mentor/students/:studentId/revision-budget` with `minutes`. |
| Open Revision or My Camp | GET `/api/v1/me/revision` for recommendations, activated decks, due cards, eligible new cards, estimated time spent, and future scheduled counts by local date. Shared cards appear once. Every read checks current lesson access. |
| Reveal a card | GET `/api/v1/me/revision/decks/:deckId/cards/:cardId` for an eligible card's front, back, deck revision, card revision and student schedule version. |
| Record recall | PUT `/review` on that card with `eventId` (client UUID), `revision`, `cardRevision`, `version` and `rating` (Again, Hard, Good or Easy). Reuse the identical event on retry. A 409 requires refreshing the queue and reconciling the pending review. |
| Review activity | GET `/api/v1/me/revision/history` returns the student's latest 100 accepted ratings and due dates. History remains available after enrollment expiry without card text. |

The server schedules each accepted rating using pinned `ts-fsrs@5.4.2`, 90% target retention, default short-term steps, and interval fuzz disabled. A review uses the server acceptance time. There is one schedule per student and canonical card across lesson links and activated decks.

Initial workload estimates allocate 60 seconds to introducing a new card and 30 seconds to reviewing a seen card. The queue deducts today's estimated time and reserves time for every due card before admitting new cards. Due cards remain available over budget and must be cleared before grading a new card. Daily accounting and the forecast use Asia/Karachi. Forecast counts reflect existing scheduled reviews and change as students rate cards. The estimates and retention setting are initial values for pilot validation.

Install locked backend dependencies, apply migrations and reapply `backend/curriculum-grants.sql` before running the updated API.
