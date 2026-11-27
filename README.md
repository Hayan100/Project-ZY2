# Project-ZY2

The TypeScript API lives in `backend/`. The first endpoints are `GET /api/v1/programs` (published programs) and `GET /health/live` (process liveness). Public catalog reads share a 60-second in-process cache. Concurrent misses share a single PostgreSQL query per API process.

## Run locally

Use Node 24.6+ and PostgreSQL. From `backend/`, run `npm ci`. Set `DATABASE_URL` to a migration-owner connection for a dedicated empty database and run `npm run migrate`. Using that owner, provision a separate API login once in psql:

```sql
CREATE ROLE project_zy2_api LOGIN;
\password project_zy2_api
GRANT USAGE ON SCHEMA public TO project_zy2_api;
GRANT SELECT ON public.public_programs TO project_zy2_api;
```

Set `DATABASE_URL` to that limited login and run `npm start`. The default listener is `127.0.0.1:3000`. Set `HOST` and `PORT` as needed. For a remote database use certificate-verified TLS. Keep credentials outside Git. Run `npm run check` and `npm test` from `backend/`.
