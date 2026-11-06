-- Shared rate-limit counters, so limits hold across several servers and restarts.
-- key_hash is a SHA-256 of the limit and its key (IP address, session or phone);
-- no raw identifiers are stored. Expired windows are deleted by the hourly cleanup job.
CREATE TABLE "rate_limits" (
    "key_hash" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "reset_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("key_hash"),
    CONSTRAINT "rate_limits_count_positive" CHECK ("count" > 0),
    CONSTRAINT "rate_limits_key_hash_sha256" CHECK ("key_hash" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "rate_limits_reset_at_idx" ON "rate_limits"("reset_at");
