-- When each payment was confirmed and refunded, for finance reports by payment date.
-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "paid_at" TIMESTAMPTZ(3),
ADD COLUMN     "refunded_at" TIMESTAMPTZ(3);


-- Existing rows: the best available date is the last change (exact for payments
-- that have not changed since; refunded payments only know their refund time).
UPDATE "payments" SET "paid_at" = "updated_at" WHERE "status" IN ('succeeded', 'refund_requested') AND "paid_at" IS NULL;
UPDATE "payments" SET "refunded_at" = "updated_at" WHERE "status" = 'refunded' AND "refunded_at" IS NULL;
