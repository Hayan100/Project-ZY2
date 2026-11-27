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

For an integrated lesson, GET `/api/v1/courses/:id/lessons/:lessonId/workspace` on entry and on return from practice. Before opening a quiz, save the current video timestamp through the lesson progress endpoint and the current ebook page through the reader’s reading endpoint. Wait for both saves to succeed. The workspace returns the saved lesson position, linked published books with their reader URLs and resume page IDs, and linked published quizzes with their URLs and the caller’s active attempt ID. Opening the workspace checks current lesson access and leaves progress untouched.

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

## My Camp, Planner and Progress

All routes below are relative to `/api/v1` and use the signed-in session. Calendar dates use Asia/Karachi. Supply full timestamps with a timezone for scheduled work. Apply migration 10 and reapply `backend/curriculum-grants.sql` before starting this API.

| Student route | Behavior |
| --- | --- |
| GET /me/camp | Compact daily planner, overdue count, next task, upcoming batch classes/tests, eligible Continue Lesson and Continue Reading links, and the dedicated Revision queue's due and new counts |
| GET /me/planner | Choose `view=today`, `week` (Monday start) or `month`, and optionally a local `date=YYYY-MM-DD`. Returns tasks and fixed events overlapping the period, overdue work, and task/minute completion totals. Add `download=true` for a JSON export. |
| POST /me/planner/tasks | Create a personal task with UUID `id`, `title`, `startsAt` and `minutes`. Optional `deadline` limits the finish time. Supply both `courseId` and `lessonId` to link an eligible lesson. |
| PATCH /me/planner/tasks/:id | Send the current `version` and a new `startsAt` or `completed` boolean. Conflicts and stale versions return 409. Moving beyond the deadline returns 422. Completion updates the planner record only. |
| POST /me/planner/fixed/:id/change-request | Propose a `startsAt` to the owner of a fixed mentor task or batch event. The current time stays in effect until its owner reschedules it. |
| GET /me/planner/events/:id | Open an event from the calendar. Eligibility requires active enrollment in its batch and an event start within that enrollment. |
| GET /me/planner-notices | Latest 100 in-app notices, including old and new times for scheduling changes |
| GET /me/progress | Individual quiz accuracy, omissions, distinct answered questions and attempt results, daily flashcard rating counts, scheduled task workload, current course and lesson-quiz coverage, and reading progress. Optional inclusive local `from` and `to` filter activity. Current coverage is a separate snapshot. Add `download=true` for JSON. |

**Plan generation and catch-up.** POST `{profile}` to `/me/planner/suggestions/preview`. The following profile schedules study between 6 and 8 p.m. on weekdays. Provide current or future dates spanning at most 366 days.

```json
{"profile":{"mode":"initial","targetExam":"MDCAT","targetDate":"2027-05-31","startDate":"2027-04-01","weekdays":[1,2,3,4,5],"startMinute":1080,"minutesPerDay":120,"preparation":"revising"}}
```

Initial plans use published, accessible, unfinished lessons with a staff-authored `estimatedMinutes`. Academic staff can set `exam` on the outline to restrict suggestions to the target track. Unlabelled courses can participate in any track. Starting students follow course order. Revising students get eligible quizzes and flashcards first. Use `mode=catch_up` for overdue flexible tasks, with mentor tasks first and earlier deadlines first within that group. Previews return proposed times and work that could not fit. POST the same profile and returned `token` to `/me/planner/suggestions/accept`. The server recomputes the proposal, rejects stale changes, and applies accepted changes in one transaction. Repeating an accepted token is safe.

**Mentor and batch schedules.** Assigned mentors preview an individual task at `POST /mentor/students/:studentId/planner/tasks/preview`, then send the same body and preview token to `/publish`. Use personal task fields plus optional `fixed`. The existing `revision_mentors` relationship determines authority. The assigning mentor can PATCH their task at `/mentor/students/:studentId/planner/tasks/:id` with its version and revised start time. Students receive publication/change notices. Assigned mentors receive old and new times for student reschedules.

Academic staff preview a calendar event at `POST /staff/planner/events/:id/preview`. Send `batchId`, `title`, `kind` (class, chapter_test, mock or revision), `startsAt`, `minutes`, and the current `revision` (0 for a new event). The preview reports affected students, overlapping events and conflicting tasks. Publish the reviewed payload and token at `/publish`. Revisions share the same event ID, update linked planners, and notify affected students and mentors in-app. Personal work keeps its time until the student approves a move.

Progress reports derive their measures from the lesson, ebook, quiz and review records. Quiz accuracy divides correct answers by committed answers and reports omissions separately. Current lesson-quiz coverage deduplicates shared questions across available lesson links. Historical results and activity counts remain accessible after expiry. Current protected study links are rechecked. Reading's lifetime visited/studied counts cover distinct book pages, while library summaries cover currently published pages.

## Student onboarding and Ghazi mentoring

Apply migration 11 and reapply `backend/curriculum-grants.sql`. As database owner, add designated enrollment coordinators' existing staff IDs to `welcome_admins`. Use the existing authenticated session for all routes below. Paths are relative to `/api/v1`.

**Student journey.** My Camp includes an onboarding checklist per enrollment. The same list is available at `GET /me/onboarding`. Scheduled batch purchases default to mentoring, other products to self-paced study. Staff can select a test-only route to direct registrants to the Test Portal. Profile confirmation is shared across purchases. Course access continues to follow enrollment dates regardless of questionnaire or welcome status.

| Action | Endpoint and behavior |
| --- | --- |
| Confirm profile | PUT /me/onboarding/profile |
| Open welcome hub | GET /onboarding/:id with the enrollment UUID. Returns the pinned questionnaire, selected preparation links, mentor availability, booking, and latest student-visible follow-up. |
| Save or submit intake | PUT /onboarding/:id/intake with the returned scope, template revision, current answer version, complete answers array of `{id,value}`, and `submit`. Drafts are resumable. Submission checks required answers. |
| Arrange a welcome | GET /onboarding/:id/slots, then PUT /onboarding/:id/booking with the current version (0 initially), mode and, for scheduled modes, a slot UUID. Modes include voice, video, scheduled_chat, async_chat, request_time and cancelled. A no-slot request can include a preference. |
| Message the Ghazi | GET or POST /onboarding/:id/messages. Send a unique message ID, current assignmentVersion and text. Set `welcome` to true to address the designated welcome Ghazi during cover. The private history index at GET /me/mentoring/history also serves expired enrollments. |
| Inspect staff access | GET /onboarding/:id/access-log |

**Staff setup and assignment.** Under `/staff/onboarding`, PUT `/products/:product` to configure route, check-in cadence and optional overdue planner/revision thresholds. PUT `/templates` with a product or batch scope, previous revision (0 initially) and questions. Preserve the five core question IDs returned by the hub. Each saved intake retains its original questions. Reserve the general questionnaire for preparation and support preferences.

PUT `/ghazis/:mentorId` with staff-set priority, capacity, availability, experience, working hours and reply target in minutes. GET `/allocation` lists students, Ghazis, current loads and the recommended next mentor. Confirm with PUT `/cases/:id/assignment`, sending mentorId, current version and an override reason when the proposed load exceeds six or the mentor's configured capacity. Transfers create a new assignment version. PUT `/cases/:id/term` to set a mentoring end date independently of the course.

**Preparation and first-week planning.** An assigned Ghazi or coordinator selects a published lesson with PUT `/staff/onboarding/cases/:id/preparation`, sending courseId, lessonId, selected and diagnostic. The lesson must belong to the purchased product. Selection pins the course revision. Republish and reselect to serve revised preparation material. Pre-start access is limited to selected lessons and their linked resources under ordinary release and prerequisite rules. To start an optional baseline, send the enrollment ID as `diagnosticEnrollmentId` on the existing lesson quiz attempt creation endpoint. The mentor case shows finalized diagnostic counts. Use the existing mentor planner preview/publish routes to schedule linked first-week tasks for the student's actual access dates.

**Appointments.** Ghazis publish slots at POST `/mentoring/slots` with id, mentorId and startsAt. Defaults are 20 minutes plus a 5-minute gap. Coordinators can set different minutes and gap. Self-service changes close two hours before the booked start. Coordinators can use the booking endpoint to override the cutoff. A replacement slot and release of the previous slot are committed together. PUT `/staff/onboarding/cases/:id/welcome-cover` with mentorId and until to select a temporary welcome substitute. The ongoing assignment continues independently. Appointments record time and format; call hosting is a separate integration.

**Mentor workspace.** GET `/mentor/onboarding` lists assigned students, appointment requests, check-ins and follow-up signals. GET `/mentor/onboarding/:id` opens submitted intake, diagnostic results and authorized follow-ups. POST `/mentor/onboarding/:id/followups` with strengths, priorities, firstWeek, nextCheckin, status, a unique id and optional privateNote or excusedUntil. The student receives a planner notice and the public summary. PUT `/mentor/duty` with onDuty to update duty status and last activity. GET `/staff/onboarding/attention` lists overdue replies and outstanding time requests. The current implementation measures reply targets in elapsed minutes; working hours are displayed separately.

**Privacy and delivery.** New assignments start a fresh chat segment. Students retain their own history. For authorized exceptional access, coordinators can grant a named staff member one assignment's chat history with an expiry at `/cases/:id/history-grants`, or grant case supervision separately at `/cases/:id/supervision` under the staff onboarding path. The two permissions have distinct scopes. Mentor messages create in-app notices without message text. This backend does not send external reminders, create WhatsApp sessions or record calls.

## My Family and Family Hall

Apply migration 12 and reapply `backend/curriculum-grants.sql`. Routes below use the authenticated session and are relative to `/api/v1`.

**Set up a space.** A welcome coordinator posts `id`, `name`, `mentorId`, `productKey` and an optional `batchId` to `/staff/families`. Create one space per Ghazi and product/batch. A space without a batch serves non-batch enrollments for that product. The onboarding assignment workflow controls family transfers and the six-mentee warning. Current assignment, start date, revocation, mentoring end date (including an explicit extension), and family restrictions determine student membership. Active members can read that space's shared chat history. A renewed enrollment assigned to the same space restores history. The former family's endpoints close on transfer.

The creating coordinator manages the space. The database owner can delegate specific spaces to other staff through `family_staff(family_id,user_id)`. Managing both participating families is required to approve rankings or certify results. Staff management permission alone grants no chat or peer roster access. PUT `/staff/families/:id/restrictions` with `memberId` and `restricted` to suspend or restore a student's access to one shared space.

| Student or Ghazi action | API |
| --- | --- |
| Find My Family | GET /me/families returns authorized spaces or an eligibility explanation. GET /families/:id includes the roster, latest chat and awards, weekly goal, captain and the requesting student's private Ghazi contact/check-in shortcut. |
| Chat | POST /families/:id/messages with a client UUID and text. Retry the identical message safely. GET the same path for the latest 50 messages, newest first. Pass the oldest returned UUID as `?before=` to read earlier messages. |
| Share presence | PUT /me/family-presence with `sharing` and `focused`. Optional `activity` and `subject` accept broad predefined values. Presence uses an explicit heartbeat and a five-minute online window. My Camp returns the same scoped family strip. |
| Nudge a teammate | PUT /families/:id/nudges with `recipient`. GET returns the recipient's recent nudges from current members. Repeated nudges coalesce for one hour. Focus hides incoming nudges, the strip and chat previews. |
| Track a weekly goal | The Ghazi PUTs `title`, positive `target` and current `version` (0 initially) to /families/:id/weekly-goal. Weekly activity counts completed planner tasks for current students since assignment, from Monday in Asia/Karachi. Peers see counts without task titles or individual academic results. |
| Rotate the captain | Volunteer via POST /families/:id/captain/volunteer with a unique `id`. The Ghazi lists /captain/volunteers and POSTs /captain/approve with `volunteerId` and `endsAt`. Only one term is active. A student may POST /captain/step-down. |
| View the Hall | GET /families/:id/hall returns weekly activity, team and individual awards and the official product/batch leaderboard. Scoped staff award an achievement or trophy at POST /staff/families/:id/awards with `id`, `title`, `kind` and optional current student `memberId`. |

**Inter-family challenges.** GET `/families/:id/challenges` for eligible opponent spaces, challenges and the caller's entry status. A Ghazi or current captain proposes a challenge at the same path with POST, supplying `id`, `away`, `title`, `opensAt` and `closesAt`. Each student sets or withdraws their own entry with PUT `/families/:id/challenges/:eventId/entry` and `{join:true}` or `{join:false}` before opening.

Challenges begin as casual. Staff can approve an official event via POST `/staff/families/challenges/:id/rank` before opening and before anyone joins. After closing, staff certify team points via PUT `/staff/families/challenges/:id/result` with `homePoints` and `awayPoints`. Both sides need an opt-in. Identical result retries are safe. The official leaderboard sums certified points from approved ranked events, with dense ranks for ties. Hall records participation and outcomes; the live battle room and assessment engine are separate workflows.

### Live duels and family battles

Paths below use `/api/v1`. Academic staff publish a paper with POST `/staff/live/papers` and `{id,mode,productKey,seconds,quiz}`. Use the lesson quiz question format. Papers are immutable. Duel practice papers can be reused. Each battle paper belongs to one event once assigned.

| Step | API |
| --- | --- |
| Invite a friend from QBank | GET `/live/duel-papers`, then POST `/live/duels` with `paper`, `friend` and optional `questionCount` for a random subset. A duel invitation expires after ten minutes. Both players discover their rooms via GET `/live/rooms`. |
| Open a Test Portal battle | After a family event opens, its staff manager POSTs `/staff/live/battles/:eventId` with `paper`, `home` and `away`. Each team object supplies a `deputy` and optional substitute `captain`. The two roles must be distinct current opt-ins. The default captain is the current approved family captain. |
| Accept | GET `/live/rooms/:id` for roster, counts, leadership, score sharing, ranked status and time limit. Each participant PUTs `/ready` under that room with `{ready:true}` to consent, or `false` to withdraw before start. Poll the room while in the lobby. All participants must be ready and present within 30 seconds. Retry readiness after returning to a stale lobby. |
| Play | GET the room for the common deadline, question set and own sheet. PUT `/answer` with `question`, `option` and current sheet `version`. Only the controller writes. After 30 seconds without a captain heartbeat, the next room interaction on that side transfers control to the deputy. The deputy can POST `/handback` when the captain is present. |
| Submit and review | Show the unanswered count and confirm. POST `/submit` with `unanswered` and sheet `version`. GET the room for submission status and final review. Release follows both submissions or expiry. Correct answers earn one point, omissions and wrong answers earn zero. Shorter elapsed time breaks score ties. Exact ties share rank. Ranked live events contribute raw points to the Hall automatically. Released individual duel answers contribute to personal progress. |
| Team discussion | POST `/messages` with `kind:text` and `body`, or address a WebRTC `offer`, `answer` or `ice` signal to a teammate using `recipient`. GET `/messages?after=0` then advance the cursor using the last ID. GET `/voice` during play for ICE configuration. Configure `BATTLE_TURN_URL` and `BATTLE_TURN_SECRET` for an operated TURN relay using shared-secret authentication. With neither configured, clients use direct connectivity. The API handles signaling and does not record audio. |

The [frontend vote-board handoff](docs/battle-vote-boards.md) covers avatar poses, visible advisory votes, accessibility, voice controls and reconnect behavior.

### Community and Virtual Library

All routes below start at `/api/v1`. Run the migrations and apply `backend/curriculum-grants.sql` to the API role. Provision moderation staff in `community_moderators` and academic subject assignments in `doubt_staff` as the database owner. Set `COMMUNITY_SUPPORT_URL` to the academy’s support destination.

**Stoat integration.** General and memes/media channels use Stoat for message bodies. The API authenticates students, checks current access, and keeps the author, message reference and moderation history in PostgreSQL. Supply the server-side `STOAT_API_URL` and `STOAT_BOT_TOKEN`. Use dedicated private text channels accessible only to the integration bot and trusted operators. Direct Stoat memberships would bypass the LMS gateway. Bind an existing Community space with PUT `/staff/community/spaces/:id/stoat` and `{channel}`, or pass `stoatChannel` at creation. An unbound social channel returns 503 on send. Current transport supports text and links. Native attachments, stock-client SSO, mobile push and production audio require provider/device validation. The integration test uses a local Stoat HTTP fixture. [Upstream API](https://github.com/stoatchat/javascript-client-api) · [Self-hosting](https://github.com/stoatchat/self-hosted)

| Community workflow | API |
| --- | --- |
| Discover and follow | GET `/community` returns announcements, followed and accessible channels, family eligibility, mentor links, support and library entry. PUT `/community/channels/:id/follow` with `{follow}`. |
| Configure | POST `/staff/community/spaces` with `id,name,kind`. Channel kinds are announcements, academic, general, media and resources. Set product, batch, family or a published course/lesson pair to scope access. Academic spaces require a subject. |
| Read and post | GET or POST `/community/channels/:id/posts`. Send `{id,text,parent?}` with a fresh UUID per post. GET accepts `before` for pagination and `q` for locally stored discussions. Announcements require a moderator. Linked lesson availability is checked on each student request. Renewal restores access to the same eligible space. |
| Resolve academic doubts | GET `/staff/community/doubts` for the assigned subjects’ open questions, or add `?history=true` for resolved threads too. POST `/staff/community/doubts/:id/reply` with `{id,text}`, or PUT `/staff/community/answers/:id/verify` to verify an existing reply. |
| Peer messages | POST `/community/dms` with `{peer}`. GET the same route to find requests. The recipient PUTs `/community/dms/:id/accept`. Read and write via `/community/dms/:id/posts`. PUT `/community/block` with `{peer,block}`. |
| Report and appeal | POST `/community/reports` with a post or eligible peer ID and reason. Staff GET `/staff/community/reports` and `/:id/evidence`, then POST `/:id/action` with kind and reason. Mutes and temporary restrictions require hours. Affected students GET `/community/actions` and PUT `/:id/appeal`. A different moderator PUTs `/staff/community/actions/:id/decision` with reason and overturn flag. |

**Virtual Library.** Create quiet or social spaces through the same staff endpoint with `capacity` and `instances`. An unscoped room can serve as a free demo. Product, batch and family can narrow the audience. Invitation-only rooms also require a product. Adjust normal capacity via PUT `/staff/library/rooms/:id/capacity`. The provisional hard ceiling is 24 per instance. The integration suite exercises 28 simultaneous entrants at that ceiling. Production network and voice load still need measurement.

| Library workflow | API |
| --- | --- |
| Find a desk | GET `/library` shows eligible rooms, the caller’s current desk, invitations and visible family members studying. POST `/library/rooms/:id/join` with `{}` for placement or `{joinPeer}` for permitted targeted entry. A full result can identify an alternative for voluntary entry. |
| Invite | From a desk, POST `/library/rooms/:id/invite` with `{peer}` for a current family member or accepted friend. A moderator can seed an invitation-only room. Invitations last one day. Current family members and their Ghazi may join one another above normal capacity up to the ceiling. |
| Study | Game and list clients GET the same `/library/desks/:id` session. Poll within the 90-second presence lease. PUT `/focus` with minutes, or zero to stop. Repeating an active timer preserves its deadline. PUT `/resource` with a published accessible course/lesson pair or an eligible ebook ID. Each student’s timer and resource remain private. DELETE the desk to leave. |
| Talk in a social instance | GET/POST `/library/desks/:id/chat` with text. PUT `/voice` with `{enabled}` to join or leave optional audio. Post addressed offer, answer and ICE messages to `/signals`, and poll that path with `after`. Use the existing TURN configuration. Clients stop microphone tracks and close connections when muted, blocked, moved, disconnected or no longer authorized. Quiet rooms have no social transport. The API does not record audio. |

### Private support tickets

Community returns the ticket inbox as its default support destination. A verified student can use it even when paid access has expired. Apply migration 15 and the curriculum grants. As the database owner, assign staff to categories in `support_reviewers(reviewer,category,senior)`. Service complaints require designated senior reviewers. A reported staff member and the ticket author are excluded from the staff view of that ticket.

| Action | API under `/api/v1` |
| --- | --- |
| Open a ticket | POST `/support/tickets` with a client UUID `id`, `category` (`access_payment`, `technical`, or `service_complaint`), `subject`, and `description`. Complaints may identify a staff member with `reportedStaff`. Repeating the same request returns the same ticket. |
| Track or review | GET `/support/tickets` for your own tickets or `/staff/support/tickets` for your assigned categories. Append `/:id` for the description and chronological history. |
| Work a ticket | POST `/:id/events` under either inbox with the current `version`, an `action`, and a student-visible `message`. Students can reply or reopen. Eligible staff can also claim, escalate or resolve. A claim transfers assignment and records who took over. Escalation releases the assignment to the senior queue and requires another eligible senior reviewer. |
| Handle a conflict | A stale edit returns 409. Refresh the thread before revising the request. Repeating an identical accepted event returns its recorded version while the caller retains access. |

### Feature suggestion board

Community exposes the board through `featureBoard`. Apply migration 16 and the curriculum grants. Verified accounts can participate without paid enrollment. The board uses the existing Community access restrictions and moderator assignments. Only the author and moderators see submitted or declined ideas. The shared board displays vote totals and the caller’s own vote.

| Action | API under `/api/v1` |
| --- | --- |
| Submit an idea | POST `/feature-suggestions` with a client UUID `id`, `title`, and `description`. An identical retry returns the existing suggestion. |
| Browse | GET `/feature-suggestions`. Moderators can GET `/staff/feature-suggestions` to include all submissions. Use the response’s `next` UUID as `?after=` for the next page. |
| Vote or withdraw | PUT `/feature-suggestions/:id/vote` with `{"voted":true}` or `{"voted":false}`. Each account has one vote per published idea. |
| Review | A Community moderator PUTs `/staff/feature-suggestions/:id/status` with the current `version` and a `status` of `under_review`, `planned`, `in_progress`, `delivered`, or `declined`. The first four statuses publish the idea. Refresh after a 409 stale update. |

### Moderated resource submissions

Apply migration 17 and the curriculum grants. Text and links in Community channels of kind `resources` use the existing post IDs and channel access checks. Existing posts in these channels enter the pending queue on upgrade.

| Action | API under `/api/v1` |
| --- | --- |
| Submit and track | POST `/community/channels/:id/posts` with a client UUID and text, then GET `/community/channels/:id/submissions/:post` for your review status. Replies use an approved parent and go through review individually. |
| Review | Community moderators GET `/staff/community/resources`. The default queue is pending. Filter by `status` and pass the returned `next` UUID as `after` to paginate. A moderator other than the author PUTs `/staff/community/resources/:post` with the current `version` and status `approved` or `declined`. Refresh after a stale edit returns 409. |
| Find a resource | GET the channel’s existing posts endpoint with an optional `q` search. Approval makes the original post visible to eligible channel members. Declining or removing the parent hides it and its replies. |

### Searchable help

Community returns the help URL in `help`. GET `/api/v1/support/help` with a verified session to browse guidance or search with `q` (up to 120 characters) and an optional support-ticket category. The response includes matching plain-text articles and the private ticket inbox URL. Guidance is maintained in source with the workflows it describes. Search reads only those articles.

### Security coverage and deployment boundaries

| Concern | Backend coverage and remaining verification |
| --- | --- |
| HTTP/2 Rapid Reset and request smuggling | Fastify uses the Node HTTP/1 listener with its strict parser, request-body limits, and a 60-second request timeout. Verify the deployed HTTP/2 terminator’s patch level and stream-abuse limits, and verify consistent request framing through the proxy to the origin. |
| Forwarded IP spoofing and cache poisoning | Proxy trust is disabled. The auth bridge constructs its client-IP header from the socket peer and builds URLs from the configured origin. Protected responses default to no-store. Only the shared public program list uses the catalog cache. Verify CDN cache rules and restrict direct origin access at deployment. |
| Long usernames and Unicode identity confusion | Permissions use database user IDs. Email signup accepts a trimmed NFC display name up to 200 UTF-16 code units and rejects control and bidirectional formatting characters. Similar-looking display names can still belong to different people. |
| SAML, OAuth email spoofing, JWT algorithms and 2FA replay | The auth route allowlist exposes email/password and optional Google OAuth. Linking checks local email verification. The installed auth library validates Google tokens against provider key and algorithm settings and pins email verification to HS256. Reusing a completed email verification link is covered by a session-cookie regression check. SAML and two-factor code endpoints are absent. A live Google callback was outside the local test. |
| Timing, random tokens and padding oracles | Better Auth hashes a candidate password even for a missing credential and performs password verification through its library. Provisioning uses Node cryptographic randomness. The HTTP API exposes no general-purpose decryption handler. Network timing and provider internals were not measured. |
| Regex denial of service, prototype pollution and template injection | Help search bounds input and uses literal substring matching. JSON parsing rejects prototype-poisoning keys. Help articles and receipts use plain text or structured JSON. Render returned text as text in clients. These checks do not constitute a performance audit of every dependency. |
| GraphQL aliases, XML external entities and WebSocket hijacking | The application registers REST routes. It has no GraphQL, XML document import or WebSocket upgrade handler. Payment-proof decoding accepts JPEG/PNG signatures and limits decoded pixel count. Voice signaling uses session-authorized HTTP routes. |
| PostgreSQL views and row-level security | The backend uses a limited database role and checks the current actor and entitlements in application queries. Database views are server-side resources. Keep database credentials and SQL access off clients. Owner-rights views require a separate privilege review before exposing SQL directly or introducing row-level policies. [PostgreSQL view security](https://www.postgresql.org/docs/current/sql-createview.html) |

### Inventory

Apply migration 18 and the curriculum grants. GET `/api/v1/inventory` for the signed-in student’s academy reference sheets and saved Community resources. This is a separate destination beside Ebooks.

| Action | API under `/api/v1` |
| --- | --- |
| Author a reference sheet | Academic staff POST `/staff/inventory/sheets` with a client UUID `id`, `title`, and plain-text `body`. Repeat the same submission safely. Link the sheet ID in a lesson’s `relatedResourceIds` and publish the course revision. To replace a sheet, publish the replacement ID in the course. |
| Read a sheet | Open its Inventory `href`, or use `/inventory/courses/:course/lessons/:lesson/sheets/:id` from the lesson. The reader checks active enrollment, the published lesson link, its release time and prerequisites at each request. A sheet shared across multiple accessible lessons appears once. |
| Save a Community resource | PUT `/inventory/community/:id` with `{"saved":true}` using the approved resource post’s ID. Inventory reads the original text or link and checks channel access, moderation, restrictions and blocks. A saved reference can become visible again after access returns. Send `{"saved":false}` to forget it, including while it is hidden. |

### Unified Saved view

Apply migration 19 and the curriculum grants. GET `/api/v1/me/saved` returns the caller’s lesson, ebook-page and Inventory bookmarks. An available item includes its reader URL. A changed lesson resource or edited page is marked `changed`. An inaccessible or removed source returns only its bookmark key and `unavailable`. A student can remove it while access is suspended.

PUT `/api/v1/me/saved` with `saved`, `kind`, `source` and `target`. For a lesson, supply the course and lesson IDs. For a page, supply the book and page IDs, plus the optional `course` and `lesson` reader context. For an academy sheet, supply the course and sheet IDs and the linking `lesson`. Community items reuse Inventory’s existing save and remove endpoint.

### Backend integration checks

GitHub Actions provisions PostgreSQL on pushes and pull requests. To run the same setup locally, point `DATABASE_URL` and `TEST_DATABASE_URL` at a fresh disposable database owned by the test connection. From `backend`, run `npm ci`, `npm run check`, `npm run migrate`, `psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f test/bootstrap.sql`, then `npm test`. In PowerShell use `$env:DATABASE_URL` for the psql argument.

The Stoat gateway reserves a digest of the send request, releases the database connection for HTTP, and rechecks authorization before publishing the message reference. Retry an interrupted send using the same UUID and text. If access is withdrawn after Stoat accepts the message, the private bot channel may contain a message without a published LMS reference.

API clients can use the stable error codes `conflict` (409) and `validation_failed` (422). The delivery worker writes structured JSON to stderr when it schedules a retry, including the invoice ID, channel, attempt, and next retry time.
