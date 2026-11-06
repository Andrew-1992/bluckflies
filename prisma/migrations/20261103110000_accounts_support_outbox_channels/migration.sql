-- CreateEnum
CREATE TYPE "session_channel" AS ENUM ('web', 'whatsapp', 'sms');

-- CreateEnum
CREATE TYPE "ticket_status" AS ENUM ('open', 'in_progress', 'resolved');

-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('email', 'sms');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('pending', 'sent', 'failed');

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "traveller_id" TEXT;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "channel" "session_channel" NOT NULL DEFAULT 'web',
ADD COLUMN     "channel_key" CHAR(64),
ADD COLUMN     "revoked_at" TIMESTAMPTZ(3),
ADD COLUMN     "traveller_id" TEXT;

-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN     "assignee" TEXT,
ADD COLUMN     "booking_id" TEXT,
ADD COLUMN     "resolved_at" TIMESTAMPTZ(3),
ADD COLUMN     "status" "ticket_status" NOT NULL DEFAULT 'open',
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "travellers" (
    "id" TEXT NOT NULL,
    "phone_hash" CHAR(64) NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "travellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "phone_hash" CHAR(64) NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_notes" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "recipient_enc" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body_enc" TEXT NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "travellers_phone_hash_key" ON "travellers"("phone_hash");

-- CreateIndex
CREATE INDEX "otp_challenges_phone_hash_created_at_idx" ON "otp_challenges"("phone_hash", "created_at");

-- CreateIndex
CREATE INDEX "otp_challenges_expires_at_idx" ON "otp_challenges"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "support_ticket_notes_seq_key" ON "support_ticket_notes"("seq");

-- CreateIndex
CREATE INDEX "support_ticket_notes_ticket_id_seq_idx" ON "support_ticket_notes"("ticket_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "notifications_status_next_attempt_at_idx" ON "notifications"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "bookings_traveller_id_idx" ON "bookings"("traveller_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_channel_key_key" ON "sessions"("channel_key");

-- CreateIndex
CREATE INDEX "sessions_traveller_id_idx" ON "sessions"("traveller_id");

-- CreateIndex
CREATE INDEX "support_tickets_status_created_at_idx" ON "support_tickets"("status", "created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_traveller_id_fkey" FOREIGN KEY ("traveller_id") REFERENCES "travellers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_traveller_id_fkey" FOREIGN KEY ("traveller_id") REFERENCES "travellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_notes" ADD CONSTRAINT "support_ticket_notes_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integrity checks (not expressible in the Prisma schema; not diffed by Prisma Migrate).
ALTER TABLE "sessions"
  -- Web sessions are anonymous browser tabs; WhatsApp/SMS sessions are keyed by sender.
  ADD CONSTRAINT "sessions_channel_key_matches_channel" CHECK (("channel" = 'web') = ("channel_key" IS NULL));
ALTER TABLE "otp_challenges"
  ADD CONSTRAINT "otp_challenges_attempts_range" CHECK ("attempts" BETWEEN 0 AND 10);
ALTER TABLE "support_tickets"
  ADD CONSTRAINT "support_tickets_resolved_at_matches_status" CHECK (("status" = 'resolved') = ("resolved_at" IS NOT NULL));
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_attempts_non_negative" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "notifications_sent_at_matches_status" CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL));
ALTER TABLE "support_ticket_notes"
  ADD CONSTRAINT "support_ticket_notes_body_not_blank" CHECK (length(btrim("body")) > 0);
