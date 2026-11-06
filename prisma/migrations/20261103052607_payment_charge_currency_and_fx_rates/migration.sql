-- Payments now record what the payer is charged (SSP for mobile money) and the
-- exchange rate locked at request time. Written by hand (not as generated) so it
-- also applies to databases that already contain payments.

-- 1. Add the columns as nullable.
ALTER TABLE "payments"
  ADD COLUMN "charge_amount_minor" INTEGER,
  ADD COLUMN "charge_currency" CHAR(3),
  ADD COLUMN "fx_as_of" TIMESTAMPTZ(3),
  ADD COLUMN "fx_markup_bps" INTEGER,
  ADD COLUMN "fx_per_usd" DECIMAL(18,6),
  ADD COLUMN "fx_source" TEXT;

-- 2. Backfill: every earlier payment was charged in its USD booking amount.
UPDATE "payments" SET "charge_amount_minor" = "amount_cents", "charge_currency" = "currency";

-- 3. Now enforce NOT NULL, as the Prisma schema declares.
ALTER TABLE "payments"
  ALTER COLUMN "charge_amount_minor" SET NOT NULL,
  ALTER COLUMN "charge_currency" SET NOT NULL;

-- Integrity checks (not expressible in the Prisma schema; not diffed by Prisma Migrate).
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_charge_positive" CHECK ("charge_amount_minor" > 0),
  ADD CONSTRAINT "payments_charge_currency_format" CHECK ("charge_currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "payments_fx_present_for_foreign_charges" CHECK (
    "charge_currency" = "currency" OR ("fx_per_usd" IS NOT NULL AND "fx_as_of" IS NOT NULL AND "fx_source" IS NOT NULL AND "fx_markup_bps" IS NOT NULL)
  ),
  ADD CONSTRAINT "payments_fx_positive" CHECK ("fx_per_usd" IS NULL OR "fx_per_usd" > 0);

-- CreateTable
CREATE TABLE "fx_rates" (
    "id" BIGSERIAL NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "per_usd" DECIMAL(18,6) NOT NULL,
    "as_of" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fx_rates_per_usd_positive" CHECK ("per_usd" > 0),
    CONSTRAINT "fx_rates_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$')
);

-- CreateIndex
CREATE INDEX "fx_rates_currency_as_of_idx" ON "fx_rates"("currency", "as_of" DESC);
