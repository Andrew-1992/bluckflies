-- Phone a traveller asked to be called on (encrypted), e.g. a booking request when the AI assistant is unavailable.
-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN     "contact_phone_enc" TEXT;

