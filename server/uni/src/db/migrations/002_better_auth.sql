-- Better Auth 1.7.7 account schema for the plugin set configured in src/account-auth.ts
-- (email/password, magic-link, device-authorization, two-factor, bearer). Generated from the
-- pinned release's own migration machinery against a scratch database, then normalized.
--
-- Short-lived verification material (email verification, password reset and hashed magic-link
-- tokens — consumed atomically on first use) intentionally has no `verification` table: the
-- pinned release routes verification storage through the configured secondary storage. `auth_kv`
-- below backs that storage and the database-backed rate limiter. Do not hand-edit; regenerate on
-- better-auth upgrades and review the diff.

CREATE TABLE "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  "emailVerified" boolean NOT NULL,
  image text,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "twoFactorEnabled" boolean,
  CONSTRAINT user_email_key UNIQUE (email)
);

CREATE TABLE session (
  id text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  token text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  CONSTRAINT session_token_key UNIQUE (token)
);

CREATE INDEX "session_userId_idx" ON session ("userId");

CREATE TABLE account (
  id text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL
);

CREATE INDEX "account_userId_idx" ON account ("userId");

CREATE TABLE "deviceCode" (
  id text PRIMARY KEY,
  "deviceCode" text NOT NULL,
  "userCode" text NOT NULL,
  "userId" text,
  "expiresAt" timestamptz NOT NULL,
  status text NOT NULL,
  "lastPolledAt" timestamptz,
  "pollingInterval" integer,
  "clientId" text,
  scope text
);

CREATE UNIQUE INDEX "deviceCode_deviceCode_uidx" ON "deviceCode" ("deviceCode");
CREATE UNIQUE INDEX "deviceCode_userCode_uidx" ON "deviceCode" ("userCode");

CREATE TABLE "twoFactor" (
  id text PRIMARY KEY,
  secret text NOT NULL,
  "backupCodes" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  verified boolean,
  "failedVerificationCount" integer,
  "lockedUntil" timestamptz
);

CREATE INDEX "twoFactor_secret_idx" ON "twoFactor" (secret);
CREATE INDEX "twoFactor_userId_idx" ON "twoFactor" ("userId");

-- Key-value storage for better-auth secondary storage: database-backed rate limits and hashed
-- short-lived verification tokens. Expiry is enforced lazily on read; `increment` is a single
-- atomic upsert (see src/rate-limit.ts).
CREATE TABLE auth_kv (
  key text PRIMARY KEY,
  value text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX auth_kv_expires_at_idx ON auth_kv (expires_at);
