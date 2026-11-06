-- Cash at a BluckFlies office or partner agent, confirmed by staff on the support desk.
-- AlterEnum
ALTER TYPE "payment_method" ADD VALUE 'cash_office';

-- Bank statement matching looks up recent payments of one method.
-- CreateIndex
CREATE INDEX "payments_method_created_at_idx" ON "payments"("method", "created_at");
