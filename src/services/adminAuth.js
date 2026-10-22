// Admin sign-in with bcrypt and account lockout (5 failures → 15 minutes).
const bcrypt = require('bcrypt');
const prisma = require('../lib/prisma');

const MAX_FAILED = 5;
const LOCK_MIN = 15;
const BCRYPT_COST = 12;
// Compared against when the email is unknown, so timing doesn't reveal which emails exist.
// Generated once, on first use, at the same cost as real hashes.
let dummyHash = null;
const getDummyHash = async () => (dummyHash = dummyHash || (await bcrypt.hash('not-a-real-password', BCRYPT_COST)));

const normaliseEmail = (email) => String(email || '').trim().toLowerCase();

/** Pure: is the account currently locked? */
function isLocked(admin, now) {
  return Boolean(admin.lockedUntil && admin.lockedUntil.getTime() > now.getTime());
}

/** Pure: minutes left on a lock, rounded up (for the message). */
function minutesLeft(admin, now) {
  return Math.max(1, Math.ceil((admin.lockedUntil.getTime() - now.getTime()) / 60_000));
}

/**
 * Returns { ok: true, admin } or { ok: false, reason } where reason is a safe message.
 * The same message is used for unknown email and wrong password.
 */
async function authenticate(email, password, { now = new Date(), db = prisma } = {}) {
  const generic = 'That email and password don’t match.';
  const admin = await db.admin.findUnique({ where: { email: normaliseEmail(email) } });
  if (!admin || !admin.active) {
    await bcrypt.compare(String(password || ''), await getDummyHash());
    return { ok: false, reason: generic };
  }
  if (isLocked(admin, now)) {
    return { ok: false, reason: `Too many attempts. Try again in ${minutesLeft(admin, now)} minutes.` };
  }

  const match = await bcrypt.compare(String(password || ''), admin.passwordHash);
  if (!match) {
    const failed = admin.failedLoginCount + 1;
    const lock = failed >= MAX_FAILED;
    await db.admin.update({
      where: { id: admin.id },
      data: {
        failedLoginCount: lock ? 0 : failed,
        lockedUntil: lock ? new Date(now.getTime() + LOCK_MIN * 60_000) : null,
      },
    });
    return {
      ok: false,
      reason: lock ? `Too many attempts. Try again in ${LOCK_MIN} minutes.` : generic,
    };
  }

  const updated = await db.admin.update({
    where: { id: admin.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
  });
  return { ok: true, admin: updated };
}

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_COST);

/** Pure: minimum password policy for admin accounts. */
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 12) return 'Use at least 12 characters.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Use letters and at least one number.';
  return null;
}

module.exports = { authenticate, hashPassword, passwordProblem, isLocked, normaliseEmail, MAX_FAILED, LOCK_MIN };
