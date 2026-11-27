-- Up Migration
CREATE TABLE "user" (
  id text PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
  "emailVerified" boolean NOT NULL DEFAULT false, image text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE account (
  id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ON DELETE CASCADE, password text,
  "accessToken" text, "refreshToken" text, "idToken" text, scope text,
  "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("providerId","accountId")
);
CREATE INDEX account_user ON account ("userId");
CREATE TABLE session (
  id text PRIMARY KEY, "userId" text NOT NULL UNIQUE REFERENCES "user" ON DELETE CASCADE,
  token text UNIQUE NOT NULL, "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
  "ipAddress" text, "userAgent" text
);
CREATE TABLE verification (
  id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
  "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
);
CREATE INDEX verification_identifier ON verification(identifier);
CREATE TABLE "rateLimit" (id text PRIMARY KEY, key text UNIQUE NOT NULL, count integer NOT NULL, "lastRequest" bigint NOT NULL);
CREATE TABLE staff_members (user_id text PRIMARY KEY REFERENCES "user" ON DELETE CASCADE);
CREATE TABLE temporary_credentials (user_id text PRIMARY KEY REFERENCES "user" ON DELETE CASCADE, valid_until timestamptz NOT NULL);
CREATE TABLE enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL REFERENCES "user",
  product_key text NOT NULL CHECK (length(product_key) BETWEEN 1 AND 120),
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, revoked_at timestamptz,
  CHECK (starts_at < ends_at)
);
CREATE INDEX enrollment_lookup ON enrollments(user_id, product_key, ends_at) WHERE revoked_at IS NULL;

CREATE FUNCTION replace_session() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE deadline timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."userId", 0));
  SELECT valid_until INTO deadline FROM temporary_credentials WHERE user_id = NEW."userId";
  IF deadline <= clock_timestamp() THEN RAISE EXCEPTION 'Activation expired'; END IF;
  NEW."expiresAt" := least(NEW."expiresAt", deadline);
  DELETE FROM session WHERE "userId" = NEW."userId";
  RETURN NEW;
END $$;
CREATE TRIGGER single_device BEFORE INSERT ON session FOR EACH ROW EXECUTE FUNCTION replace_session();

CREATE FUNCTION finish_password_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM public.temporary_credentials WHERE user_id = NEW."userId";
  DELETE FROM public.session WHERE "userId" = NEW."userId";
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finish_password_change() FROM PUBLIC;
CREATE TRIGGER credential_changed AFTER UPDATE OF password ON account
FOR EACH ROW WHEN (OLD.password IS DISTINCT FROM NEW.password) EXECUTE FUNCTION finish_password_change();

-- Down Migration
DROP TABLE enrollments, temporary_credentials, staff_members, "rateLimit", verification, session, account, "user";
DROP FUNCTION replace_session(), finish_password_change();
