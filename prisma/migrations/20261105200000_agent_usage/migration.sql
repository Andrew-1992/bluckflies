-- AI model usage per conversation per Juba day, for the assistant's spending limits
-- (AGENT_DAILY_BUDGET_USD, AGENT_CONVERSATION_BUDGET_USD) and the AI usage report.
-- No foreign key to sessions: spend history is kept after chats are purged.
CREATE TABLE "agent_usage" (
    "day" DATE NOT NULL,
    "session_id" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_write_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_usage_pkey" PRIMARY KEY ("day","session_id"),
    CONSTRAINT "agent_usage_non_negative" CHECK (
        "calls" >= 0 AND "input_tokens" >= 0 AND "output_tokens" >= 0
        AND "cache_write_tokens" >= 0 AND "cache_read_tokens" >= 0 AND "cost_micros" >= 0
    )
);
