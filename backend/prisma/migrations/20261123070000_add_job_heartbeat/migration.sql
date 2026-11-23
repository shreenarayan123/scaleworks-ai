ALTER TABLE "Job" ADD COLUMN "workerId" TEXT;
ALTER TABLE "Job" ADD COLUMN "heartbeatAt" TIMESTAMP(3);

CREATE INDEX "Job_stage_heartbeatAt_idx" ON "Job"("stage", "heartbeatAt");
