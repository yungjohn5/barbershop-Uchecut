-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('WEB', 'STAFF');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "source" "BookingSource" NOT NULL DEFAULT 'WEB',
ADD COLUMN     "staffNotes" TEXT;
