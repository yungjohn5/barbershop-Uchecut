-- Safety net against double booking, independent of application code.
-- A barber can never hold two active (PENDING/CONFIRMED) bookings whose
-- blocked ranges (service time + travel buffers) overlap. Ranges are
-- half-open '[)', so back-to-back bookings (10:00-10:30, 10:30-11:00) are fine.
-- Violations raise SQLSTATE 23P01 (exclusion_violation), which
-- src/services/booking.js maps to SlotTakenError.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_block_range_valid"
  CHECK ("blockStartsAt" < "blockEndsAt"
     AND "blockStartsAt" <= "startsAt"
     AND "startsAt" < "endsAt"
     AND "endsAt" <= "blockEndsAt");

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_no_overlap"
  EXCLUDE USING gist (
    "barberId" WITH =,
    tstzrange("blockStartsAt", "blockEndsAt", '[)') WITH &&
  )
  WHERE ("status" IN ('PENDING', 'CONFIRMED'));
