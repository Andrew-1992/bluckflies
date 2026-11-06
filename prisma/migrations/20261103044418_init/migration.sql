-- CreateEnum
CREATE TYPE "booking_status" AS ENUM ('held', 'payment_pending', 'ticketing', 'ticketed', 'expired', 'cancelled', 'refund_pending', 'refunded');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('mtn_momo', 'zain_mgurush', 'card');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('requested', 'succeeded', 'failed', 'cancelled', 'refund_requested', 'refunded');

-- CreateEnum
CREATE TYPE "confirmation_kind" AS ENUM ('create_reservation', 'cancel_booking');

-- CreateEnum
CREATE TYPE "confirmation_status" AS ENUM ('pending', 'confirmed', 'declined', 'expired');

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "pnr" CHAR(6) NOT NULL,
    "owner_session_id" TEXT NOT NULL,
    "status" "booking_status" NOT NULL,
    "offer" JSONB NOT NULL,
    "total_amount_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "passengers_enc" TEXT NOT NULL,
    "contact_enc" TEXT NOT NULL,
    "hold_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "ticket_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "supplier_reference" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "booking_id" TEXT NOT NULL,
    "method" "payment_method" NOT NULL,
    "provider" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "payment_status" NOT NULL,
    "provider_reference" TEXT NOT NULL,
    "refund_reference" TEXT,
    "approval_instructions" TEXT NOT NULL,
    "checkout_url" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "confirmations" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "kind" "confirmation_kind" NOT NULL,
    "summary" TEXT NOT NULL,
    "payload_enc" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "confirmation_status" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "session_id" TEXT NOT NULL,
    "messages_enc" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_leases" (
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "lease_until" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_leases_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "offers_session_id_idx" ON "offers"("session_id");

-- CreateIndex
CREATE INDEX "offers_expires_at_idx" ON "offers"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_pnr_key" ON "bookings"("pnr");

-- CreateIndex
CREATE INDEX "bookings_owner_session_id_idx" ON "bookings"("owner_session_id");

-- CreateIndex
CREATE INDEX "bookings_status_hold_expires_at_idx" ON "bookings"("status", "hold_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_seq_key" ON "payments"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_reference_key" ON "payments"("provider_reference");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "payments_booking_id_seq_idx" ON "payments"("booking_id", "seq");

-- CreateIndex
CREATE INDEX "payments_status_provider_updated_at_idx" ON "payments"("status", "provider", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_one_open_request_per_booking" ON "payments"("booking_id") WHERE (status = 'requested');

-- CreateIndex
CREATE INDEX "confirmations_session_id_status_idx" ON "confirmations"("session_id", "status");

-- CreateIndex
CREATE INDEX "confirmations_expires_at_idx" ON "confirmations"("expires_at");

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

-- CreateIndex
CREATE INDEX "support_tickets_created_at_idx" ON "support_tickets"("created_at");

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_owner_session_id_fkey" FOREIGN KEY ("owner_session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity checks (not expressible in the Prisma schema; Prisma Migrate does
-- not diff CHECK constraints, so they persist across future migrations).
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_pnr_format" CHECK ("pnr" ~ '^[A-HJ-NP-Z2-9]{6}$'),
  ADD CONSTRAINT "bookings_amount_non_negative" CHECK ("total_amount_cents" >= 0),
  ADD CONSTRAINT "bookings_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "bookings_ticket_numbers_present" CHECK ("ticket_numbers" IS NOT NULL),
  ADD CONSTRAINT "bookings_ticketed_has_tickets" CHECK ("status" <> 'ticketed' OR cardinality("ticket_numbers") > 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive" CHECK ("amount_cents" > 0),
  ADD CONSTRAINT "payments_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
