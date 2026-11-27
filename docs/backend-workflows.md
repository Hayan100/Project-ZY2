# Backend workflow guide

Apply migrations 21 through 38 after the Student exports migration. Reapply both payment and curriculum grants as the database owner. The endpoints below use the existing verified session and the `/api/v1` prefix. No production provider credentials are needed to run the database integration tests.

## Cohort lectures

Publish a video lesson with a `premiere` object containing `durationSeconds`, `thresholdPercent`, `downloads` and ordered, nonoverlapping `slots`. Each slot has timezone-qualified `opens`, `closes` and `continueUntil` timestamps. Open the lesson’s `premiereHref` to see its deadlines before posting to `/start`. A first start must be inside a slot unless replay is already available. Reconnecting to a started slot preserves the earlier of its original deadline and the current published deadline.

Academic staff can import confirmed intervals at `PUT /staff/courses/:course/lessons/:lesson/played` using student, resource, slotOpens, observedAt, from and to. Offsets are integer seconds. Coverage unions intervals for the same student, course, lesson and video across permitted slots. Rewatching the same seconds adds no credit. The media adapter must report observed played portions after accounting for seeking and playback speed. Saving the ordinary lesson cursor grants no credit.

After a missed slot, PUT a client UUID and reason to `/requests` under the premiere URL. Staff review `GET /staff/replay-requests` and PUT a decision to `/:id` with `expiresAt` for approval. The student sees decisions at the premiere URL. `POST /download-authorization` checks the same replay and enrollment rules on issue and renewal, requires enabled downloads and caps authorization at seven days, applicable exception expiry and paid access expiry. Native license issuance, encryption and watermark rendering require the protected-media integration.

## Formal Test Portal

Academic staff POST an immutable quiz and rules snapshot to `/staff/tests`. Rules specify opening, entry cutoff, ranked close, duration, grace, pause, irreversible OMR choices, ranked-attempt allowance, correct/wrong/omitted points and score, rank and key release times. Optional product, batch or paid-offer restrictions narrow registration. Optional staff-defined registration fields supplement the standard profile. Optional `practiceUntil` allows unranked practice after closure.

Use `GET /tests`, `PUT /tests/:id/registration`, and `GET /tests/:id/lobby`. Existing identity and payment verification apply. The lobby returns rules, registration ID and attempts. POST a retryable attempt UUID to `/tests/:id/attempts`. The returned deadline applies across devices. Strict mode uses the common deadline. Grace mode deducts lateness beyond grace. Window mode gives the configured duration up to ranked close.

Open `/test-attempts/:id`. PUT a version and question-to-option map to `/answers`; a null option clears an editable answer. Persist pending changes on the client and flush them before POSTing the acknowledged version to `/submit`. A 409 requires reconciliation. PUT `{paused:true}` or `{paused:false}` to `/pause` when enabled. A paused attempt hides content and rejects writes. Hard close applies during pauses. Expired attempts score from durable answers even without a further client request. Separate late batches go to `/late-changes` and are visible to academic staff.

Staff can POST a replacement UUID, explicit deadline and reason to `/staff/tests/attempts/:id/reset`. A ranked replacement supersedes the original for ranking. A post-release practice replacement preserves the published ranked result. The replacement starts empty. `GET /tests/:id/results` applies component release times. The leaderboard uses the best eligible score per registrant and dense ranks. The export index includes released personal formal scores.

## QBank and progress

Author quiz questions with optional exam, syllabus, subject, chapter, topic, difficulty and bank tags. Untagged older questions use the authored bank. `GET /me/qbank/availability` accepts those filters and an optional pool of all, unused, used, correct, incorrect, omitted or marked. Available and used counts deduplicate question identities across currently accessible published lessons.

POST `id, mode, count, filter` to `/me/qbank/quizzes`. Timed mode also requires minutes. A request exceeding availability returns 422. Open `/:id` to resume, PUT option and version to `/answers/:question`, and POST version to `/submit`. Tutor answers commit and reveal individually. Timed choices stay provisional until submission or expiry. Both use the same individual history as lesson questions and released duel answers. Team answers stay in team history.

For lesson attempts, PUT `kind` (mark or flag) and `selected` to `/questions/:questionId/selection` on the attempt. Marks persist across practice. Flags belong to one attempt. Use `/me/qbank/mistakes` for historical incorrect and omitted answers. PUT a versioned reflection at `/mistakes/:attempt/:question/reflection`. Report a currently accessible question at `/me/qbank/reports`. Academic staff resolve or decline a report with a private reply through `/staff/qbank/reports/:id`.

POST a comparison season to `/staff/qbank/seasons` with the exam/syllabus cohort’s product key, explicit dates, minimum answered questions and minimum other peers. Students open `/me/qbank/seasons` and `/:id/percentile`. Each qualifying enrolled student contributes one repeat-inclusive individual accuracy. Percentile is 100 times the number of other eligible students below the caller plus half the number tied, divided by the number of other eligible students. Insufficient data yields a null percentile.

Send visible, foreground activity intervals up to 60 seconds long to `PUT /me/qbank/activity`. Stop collection on pause, blur or background. `GET /me/qbank/performance` groups responses by Karachi date and unions overlapping intervals. Optional subject and timestamp filters apply. Activity is self-reported screen time.

For spreadsheet imports, send parsed worksheet rows to `POST /staff/quizzes/import-preview` with a quiz title. Each row has stem, ordered options, a one-based correct option and explanation. Optional tags use the question fields above. Preview reports invalid option numbers by row. Save the returned quiz through the existing staff draft endpoint and publish after review.

## Notes, annotations and revision

Personal note saves accept optional subject and topic. Browse `/me/notes` with either filter, and recover previous text at `/me/notes/:id/history`. For an ebook page, PUT id, revision, version, start, end and body to its `/annotations` endpoint using the same reader context. Offsets count UTF-16 code units in block text joined by one newline. A changed or removed page keeps the original anchor and is reported as unresolved. Open the book’s `/annotations` list to inspect anchor state. The student’s version history and exported annotation text remain available after access expiry.

Use `/me/revision/personal` to create and browse personal cards. POST a client request UUID, front and back. PUT the current revision and revised text to `/:id`, or GET `/:id/history`. Personal cards share the due-first FSRS queue, budget and forecast with academy cards. Personal content remains private after enrollment expiry.

## Study assistant and live classes

PDF manuscripts use `pdfAssetId` and an ordered list of stable page IDs. The client posts to the page's `/pdf-access` endpoint for a short-lived HTTPS page URL. The `PDF_PAGE_URL` adapter must return a protected URL specific to the requested asset, page and student, expiring within 60 seconds. Set `PDF_PAGE_TOKEN` if the adapter requires bearer authentication. Save fixed-page pen strokes at the page's `/ink` endpoint using normalized x/y coordinates, current stroke version, and original book revision. Read the book's `/ink` list to restore strokes. An empty replacement stroke erases it from the current view. Replacing the PDF asset or moving the page marks the original stroke unresolved.

Designated content security staff configure the offline grace period and distinct-page thresholds at `/staff/content-access/policy/:product`. Opening an eligible encrypted local book requires an online `POST /me/offline/ebook` grant capped at enrollment expiry. Review temporary reading holds at `/staff/content-access/alerts`. The client implements encryption, session binding and the offline expiry check. The backend currently records ebook page deliveries for these holds.

Academic staff set questions and period length in days at `PUT /staff/ai-allowances/:product`. Periods use Karachi calendar days anchored on 1 January 2000. Read the remaining balance at `/me/study-assistant/allowance/:product`. POST a unique request ID, product, question and published book/page source to `/me/study-assistant`. Lesson-only books need courseId and lessonId in source. A repeated successful request returns its saved answer. A new follow-up uses a new allowance unit. Failed provider calls release their reservation. Abandoned reservations expire after one minute.

Set `STUDY_ASSISTANT_URL` and optionally `STUDY_ASSISTANT_TOKEN` for the approved server adapter. It receives the question and the authorized page and returns a plain-text answer in JSON. The backend checks the page and allowance again before returning the answer and attaches the canonical source link. The adapter has no planner or mentor write tools.

Create broadcast or interactive sessions at `POST /staff/classes` with product, optional batch, title and opening/closing timestamps. `GET /classes` lists eligible sessions. POST to `/:id/join` for a session-specific HTTPS meeting URL. The adapter at `CLASSROOM_JOIN_URL` must confirm recording and mint a short-lived, student-scoped URL. It can authenticate using `CLASSROOM_TOKEN`. Microphone, media transport and recording storage belong to that integration.

During class, POST presence heartbeats at intervals under 60 seconds. Attendance unions contiguous confirmed intervals and excludes long disconnects. Students can open their attendance and assigned mentors can review it. Staff corrections record reason, actor and duration. Broadcast chat and questions enter moderation. Small interactive sessions display posts directly. Staff publish polls with unique options, and students can update their own vote before close. Staff attach a replay asset UUID after the class and may grant a time-limited replay extension to an individual. Opening the replay records a separate replay visit.

### MDCATEMY YouTube broadcasts

Apply migration 39 and the curriculum grants. In YouTube Studio schedule an **unlisted** event on the MDCATEMY channel, enable embedding and recording, disable automatic start, and connect the encoder. Schedule a broadcast class through the staff endpoint with its 11-character `youtubeVideoId`. Configure the academy API origin through `AUTH_ORIGIN`. If your YouTube content-owner account offers embed domain restrictions, allow only the academy domain there. That restriction must be configured on YouTube. A copied unlisted watch link remains valid until the video becomes private.

Run `npm run youtube-classes` periodically (for example every 30 seconds) with a dedicated database login supplied via `YOUTUBE_WORKER_DATABASE_URL` (SELECT on classes and UPDATE on its youtube_state column), `MDCATEMY_YOUTUBE_CHANNEL_ID`, and channel-owner OAuth settings `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` with the youtube.force-ssl scope. The worker verifies the broadcast channel, asks YouTube to go live during the window, confirms live status before exposing the player, and ends and privatizes the archive after closing. Monitor failed runs and YouTube quota. Retry pending transitions; when the worker is offline, academy access still closes but YouTube changes await recovery.

Join returns the same-origin watch URL. First-time viewers enter their mobile number specifically for the watermark. The server uses the signed-in account name and email. During playback a translucent identity block appears for six seconds after each randomly chosen three-to-five-minute interval of playback, at a random position inside the video. Fullscreen expands the entire classroom player; a viewport-sized layout is used when element fullscreen is unavailable. The mark is local to the academy viewing experience. Native playback, external YouTube links and the YouTube archive do not contain the student mark. Test the actual event on desktop, Android and iPhone before launch.

The page rechecks the active session every 30 seconds. Repeated switching between two observed network addresses within 90 seconds sets classroom_network.flagged_at on the session for staff investigation. A single network change does not revoke access. Only the immediate network peer is used unless the server has a trusted proxy configuration. Shortcut suppression applies only to events delivered to the page. Signed URLs and DRM require a separate media provider.

## Sales, admissions and discovery

Refund requests use `POST /invoices/:id/refund` with a UUID and reason. Verified finance staff record approval or decline and the approved amount, then record the external settlement reference. Total approvals cannot exceed verified receipts. These endpoints record the decision and settlement evidence. Staff handle the actual return payment and product-specific access adjustments separately.

Configure duration-based renewal offers at `POST /payments/renewals/:id` with included services. Eligible students find them at `/me/renewals`. Checkout routes an overlapping purchase to `/me/purchase-cases`. A plan approver can resolve it with a nonoverlapping offer for the same product. Scholarship cases use an explicitly requested positive price; approval creates a private offer for that student. The ordinary invoicing and payment checks still apply.

Marketing consent uses `PUT /me/admissions-consent`. Assign authorized operators and independent approvers in `marketing_staff`. Create, preview and approve immutable campaign sequences through `/staff/admissions-campaigns`. Run `npm run campaigns` periodically using `CAMPAIGN_DATABASE_URL`, `CAMPAIGN_DELIVERY_URL` and optional `CAMPAIGN_DELIVERY_TOKEN`. The adapter must deduplicate its idempotency key. Delivery rechecks consent, verified address, prior sequence steps and purchase of the promoted product. Transactional receipts use the existing separate worker.

Use `/me/search?q=...` for eligible courses, unlocked lessons, library books and personal notes. `/staff/home` lists queues covered by the caller’s roles. Academic staff can designate individual revision-pinned ebook pages, deck cards, questions or lesson previews at `/staff/samples`. Students open those items at `/samples`. A sample question accepts one committed answer per student. A new publication requires fresh sample selection.

## Recovery and confidential feedback

After verifying ownership, a separately designated member of `recovery_staff` posts a UUID, student ID, evidence reference and decision to `/staff/account-recovery`. Approval issues a one-use Better Auth reset link to the existing verified email. The client reset page reads the token from the URL fragment and posts it and the new password to `/api/auth/reset-password`. A successful reset revokes existing sessions. Recovery evidence should identify the verified record without copying a payment screenshot or secret.

Senior reviewers can POST acknowledgement and resolution targets in minutes to `/staff/support/targets` for their own category. The existing authorized ticket lists show deadlines and overdue status. Feedback leads configure version-stable recurring batch questionnaires at `/staff/feedback`, including the reviewer, cadence, questions, reporting minimum and optional staff subject. Students read `/me/feedback` and submit the displayed period, one rating per question and optional comment. Only the designated reviewer can see individual submissions. Leadership trends suppress groups below the configured minimum. The staff subject cannot review their own survey or enter leadership actions on it.

For a shared on-video watermark, add docs/obs-class-watermark.html to OBS as a local Browser Source above the lesson sources and set its dimensions to the stream canvas. The mark is encoded into the broadcast and its recording. The teacher must apply it to every scene used on air.

### Course media and reader watermarks

Video lessons and attached replay assets expose a same-origin `watchHref`. Configure `VIDEO_PLAYBACK_URL` and optional `VIDEO_PLAYBACK_TOKEN` for the trusted media adapter. It receives the authorized asset and student IDs and returns a student-scoped HTTPS playback URL in `url`. Keep provider credentials on the server. The academy player uses the same periodic watermark as live classes. Offline video grants include the identity and interval policy for the native player.

HTML ebook page URLs serve a continuously stamped reader when requested as HTML. JSON clients and offline grants receive the same tiled SVG. Each tile reads name, phone, email. PUT a mobile number to `/api/v1/me/watermark-phone` for students who have not entered one in a live class. The PDF adapter receives `watermark.svg` and `stampId`. Return `appliedStampId` only after applying the supplied stamp to the student�s page. For existing adapters the backend fetches the authorized single-page PDF or raster image and stamps it locally at the authenticated GET page URL.
