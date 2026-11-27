-- Run as owner against a freshly migrated disposable database.
CREATE ROLE zy2_api;
CREATE ROLE zy2_delivery;
GRANT SELECT ON public_programs,staff_members,temporary_credentials,enrollments TO zy2_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification,"rateLimit" TO zy2_api;
\ir ../payment-grants.sql
\ir ../delivery-grants.sql
\ir ../curriculum-grants.sql
