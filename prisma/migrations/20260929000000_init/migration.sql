-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TargetType" AS ENUM ('ORIGIN', 'CDN', 'PANEL', 'SUBSCRIPTION', 'API', 'CUSTOM');

-- CreateEnum
CREATE TYPE "CheckType" AS ENUM ('NETWORK', 'XRAY_E2E');

-- CreateEnum
CREATE TYPE "HealthState" AS ENUM ('UNKNOWN', 'UP', 'DEGRADED', 'DOWN');

-- CreateEnum
CREATE TYPE "Classification" AS ENUM ('HEALTHY', 'DEGRADED', 'RU_UNAVAILABLE', 'REGIONAL_OUTAGE', 'GLOBAL_OUTAGE', 'PROBE_UNAVAILABLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ProbeStatus" AS ENUM ('UNKNOWN', 'ONLINE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('SCHEDULED', 'MANUAL');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CheckStage" AS ENUM ('DNS', 'TCP', 'TLS', 'HTTP');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('TARGET_DOWN', 'TARGET_RECOVERED', 'TARGET_REMINDER', 'PROBE_DOWN', 'PROBE_RECOVERED', 'CERT_EXPIRING');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "Granularity" AS ENUM ('HOUR', 'DAY');

-- CreateTable
CREATE TABLE "InfraGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "flag" TEXT NOT NULL DEFAULT '🌐',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InfraGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoringTarget" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TargetType" NOT NULL DEFAULT 'CUSTOM',
    "checkType" "CheckType" NOT NULL DEFAULT 'NETWORK',
    "hostname" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'https',
    "port" INTEGER NOT NULL DEFAULT 443,
    "path" TEXT NOT NULL DEFAULT '/',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "intervalSeconds" INTEGER NOT NULL DEFAULT 30,
    "timeoutMs" INTEGER NOT NULL DEFAULT 5000,
    "failureThreshold" INTEGER NOT NULL DEFAULT 3,
    "recoveryThreshold" INTEGER NOT NULL DEFAULT 2,
    "expectedStatusCodes" INTEGER[] DEFAULT ARRAY[200, 301, 302, 403, 404]::INTEGER[],
    "certWarnDays" INTEGER NOT NULL DEFAULT 7,
    "regions" TEXT[] DEFAULT ARRAY['RU', 'EU']::TEXT[],
    "allowPrivate" BOOLEAN NOT NULL DEFAULT false,
    "groupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitoringTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Probe" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "provider" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "ProbeStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastSeenAt" TIMESTAMP(3),
    "statusSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" TEXT,
    "publicIp" TEXT,
    "secretVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Probe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProbeTarget" (
    "probeId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "state" "HealthState" NOT NULL DEFAULT 'UNKNOWN',
    "failStreak" INTEGER NOT NULL DEFAULT 0,
    "okStreak" INTEGER NOT NULL DEFAULT 0,
    "stateSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,

    CONSTRAINT "ProbeTarget_pkey" PRIMARY KEY ("probeId","targetId")
);

-- CreateTable
CREATE TABLE "CheckJob" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "probeId" TEXT NOT NULL,
    "kind" "JobKind" NOT NULL DEFAULT 'SCHEDULED',
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CheckJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckResult" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "targetId" TEXT NOT NULL,
    "probeId" TEXT NOT NULL,
    "kind" "JobKind" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "failedStage" "CheckStage",
    "dnsSuccess" BOOLEAN,
    "dnsLatencyMs" INTEGER,
    "tcpSuccess" BOOLEAN,
    "tcpLatencyMs" INTEGER,
    "tlsSuccess" BOOLEAN,
    "tlsLatencyMs" INTEGER,
    "httpSuccess" BOOLEAN,
    "httpStatus" INTEGER,
    "httpLatencyMs" INTEGER,
    "totalLatencyMs" INTEGER,
    "resolvedIp" TEXT,
    "tlsCertExpiresAt" TIMESTAMP(3),
    "tlsCertDaysLeft" INTEGER,
    "errorType" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "CheckResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckAggregate" (
    "targetId" TEXT NOT NULL,
    "probeId" TEXT NOT NULL,
    "granularity" "Granularity" NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "total" INTEGER NOT NULL,
    "ok" INTEGER NOT NULL,
    "avgLatencyMs" INTEGER,
    "maxLatencyMs" INTEGER,

    CONSTRAINT "CheckAggregate_pkey" PRIMARY KEY ("targetId","probeId","granularity","bucket")
);

-- CreateTable
CREATE TABLE "TargetState" (
    "targetId" TEXT NOT NULL,
    "status" "HealthState" NOT NULL DEFAULT 'UNKNOWN',
    "classification" "Classification" NOT NULL DEFAULT 'UNKNOWN',
    "regionStates" JSONB NOT NULL DEFAULT '{}',
    "reason" TEXT,
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TargetState_pkey" PRIMARY KEY ("targetId")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "classification" "Classification" NOT NULL DEFAULT 'UNKNOWN',
    "affectedRegions" TEXT[],
    "reason" TEXT,
    "lastReminderAt" TIMESTAMP(3),

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'telegram',
    "recipient" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "incidentId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InfraGroup_name_key" ON "InfraGroup"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MonitoringTarget_name_key" ON "MonitoringTarget"("name");

-- CreateIndex
CREATE INDEX "MonitoringTarget_enabled_idx" ON "MonitoringTarget"("enabled");

-- CreateIndex
CREATE INDEX "MonitoringTarget_groupId_idx" ON "MonitoringTarget"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "Probe_name_key" ON "Probe"("name");

-- CreateIndex
CREATE INDEX "Probe_region_idx" ON "Probe"("region");

-- CreateIndex
CREATE INDEX "ProbeTarget_nextRunAt_idx" ON "ProbeTarget"("nextRunAt");

-- CreateIndex
CREATE INDEX "CheckJob_probeId_status_createdAt_idx" ON "CheckJob"("probeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CheckJob_batchId_idx" ON "CheckJob"("batchId");

-- CreateIndex
CREATE INDEX "CheckJob_status_expiresAt_idx" ON "CheckJob"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CheckResult_jobId_key" ON "CheckResult"("jobId");

-- CreateIndex
CREATE INDEX "CheckResult_targetId_probeId_createdAt_idx" ON "CheckResult"("targetId", "probeId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CheckResult_createdAt_idx" ON "CheckResult"("createdAt");

-- CreateIndex
CREATE INDEX "CheckAggregate_granularity_bucket_idx" ON "CheckAggregate"("granularity", "bucket");

-- CreateIndex
CREATE INDEX "Incident_targetId_resolvedAt_idx" ON "Incident"("targetId", "resolvedAt");

-- CreateIndex
CREATE INDEX "Incident_startedAt_idx" ON "Incident"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_dedupeKey_key" ON "Alert"("dedupeKey");

-- CreateIndex
CREATE INDEX "Alert_status_nextAttemptAt_idx" ON "Alert"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "MonitoringTarget" ADD CONSTRAINT "MonitoringTarget_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "InfraGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbeTarget" ADD CONSTRAINT "ProbeTarget_probeId_fkey" FOREIGN KEY ("probeId") REFERENCES "Probe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbeTarget" ADD CONSTRAINT "ProbeTarget_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "MonitoringTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckJob" ADD CONSTRAINT "CheckJob_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "MonitoringTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckJob" ADD CONSTRAINT "CheckJob_probeId_fkey" FOREIGN KEY ("probeId") REFERENCES "Probe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckResult" ADD CONSTRAINT "CheckResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CheckJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckResult" ADD CONSTRAINT "CheckResult_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "MonitoringTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckResult" ADD CONSTRAINT "CheckResult_probeId_fkey" FOREIGN KEY ("probeId") REFERENCES "Probe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckAggregate" ADD CONSTRAINT "CheckAggregate_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "MonitoringTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckAggregate" ADD CONSTRAINT "CheckAggregate_probeId_fkey" FOREIGN KEY ("probeId") REFERENCES "Probe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetState" ADD CONSTRAINT "TargetState_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "MonitoringTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "MonitoringTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- At most one active scheduled job per (target, probe): guarantees checks never overlap.
CREATE UNIQUE INDEX "CheckJob_active_scheduled_uniq"
  ON "CheckJob" ("targetId", "probeId")
  WHERE "kind" = 'SCHEDULED' AND "status" IN ('PENDING', 'RUNNING');
