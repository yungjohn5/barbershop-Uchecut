-- CreateEnum
CREATE TYPE "BookingEventType" AS ENUM ('CREATED', 'CONFIRMED', 'RESCHEDULED', 'CANCELLED', 'COMPLETED', 'NO_SHOW', 'RESTORED');

-- CreateEnum
CREATE TYPE "BookingActor" AS ENUM ('CUSTOMER', 'STAFF', 'SYSTEM');

-- CreateTable
CREATE TABLE "BookingEvent" (
    "id" SERIAL NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "type" "BookingEventType" NOT NULL,
    "actor" "BookingActor" NOT NULL,
    "byName" TEXT,
    "note" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingEvent_bookingId_createdAt_idx" ON "BookingEvent"("bookingId", "createdAt");

-- AddForeignKey
ALTER TABLE "BookingEvent" ADD CONSTRAINT "BookingEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill history for existing bookings from their timestamps.
INSERT INTO "BookingEvent" ("bookingId", "type", "actor", "createdAt")
SELECT "id", 'CREATED', CASE WHEN "source" = 'STAFF' THEN 'STAFF'::"BookingActor" ELSE 'CUSTOMER'::"BookingActor" END, "createdAt"
FROM "Booking";

INSERT INTO "BookingEvent" ("bookingId", "type", "actor", "createdAt")
SELECT "id", 'CONFIRMED', 'STAFF', "confirmedAt"
FROM "Booking"
WHERE "confirmedAt" IS NOT NULL AND "type" = 'HOME' AND "source" = 'WEB';

INSERT INTO "BookingEvent" ("bookingId", "type", "actor", "note", "createdAt")
SELECT "id", 'CANCELLED',
       CASE WHEN "cancelReason" = 'Cancelled by customer' THEN 'CUSTOMER'::"BookingActor" ELSE 'STAFF'::"BookingActor" END,
       "cancelReason", "cancelledAt"
FROM "Booking"
WHERE "cancelledAt" IS NOT NULL;
