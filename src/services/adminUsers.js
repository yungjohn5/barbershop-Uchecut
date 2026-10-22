// Admin accounts (OWNER manages; everyone can change their own password).
// Deactivating an account or resetting its password also ends its open sessions.
const bcrypt = require('bcrypt');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { HttpError, NotFoundError, ValidationError } = require('../lib/errors');
const { hashPassword, passwordProblem, normaliseEmail } = require('./adminAuth');
const { parse } = require('./catalog');

const ROLES = ['OWNER', 'STAFF'];
const nameField = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() : v),
  z
    .string({ invalid_type_error: 'Enter a name.' })
    .min(2, 'Enter a name.')
    .max(60, 'Keep it under 60 characters.'),
);
const roleField = z.enum(ROLES, { errorMap: () => ({ message: 'Choose a role.' }) });

function checkPassword(password, path = 'password') {
  const problem = passwordProblem(password);
  if (problem) throw new ValidationError(problem, [{ path, message: problem }]);
}

/** End every session belonging to an admin, optionally keeping one (the current). */
async function endSessions(adminId, { keepSid = null, db = prisma } = {}) {
  if (keepSid) {
    await db.$executeRaw`DELETE FROM "session" WHERE (sess->>'adminId')::int = ${adminId} AND sid <> ${keepSid}`;
  } else {
    await db.$executeRaw`DELETE FROM "session" WHERE (sess->>'adminId')::int = ${adminId}`;
  }
}

const listAdmins = ({ db = prisma } = {}) =>
  db.admin.findMany({
    orderBy: [{ active: 'desc' }, { role: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      lastLoginAt: true,
      lockedUntil: true,
      createdAt: true,
    },
  });

async function createAdmin(body, { db = prisma } = {}) {
  const data = parse(
    z.object({
      name: nameField,
      email: z.preprocess(
        (v) => normaliseEmail(v),
        z.string().email('Enter a valid email.').max(120),
      ),
      role: roleField,
    }),
    body,
  );
  checkPassword(body.password);
  if (await db.admin.findUnique({ where: { email: data.email } })) {
    throw new ValidationError('That email already has an account.', [
      { path: 'email', message: 'Already has an account.' },
    ]);
  }
  return db.admin.create({ data: { ...data, passwordHash: await hashPassword(body.password) } });
}

async function activeOwnerCount(db, excludeId) {
  return db.admin.count({ where: { role: 'OWNER', active: true, id: { not: excludeId } } });
}

async function updateAdmin(id, body, { actorId, db = prisma } = {}) {
  const data = parse(z.object({ name: nameField, role: roleField }), body);
  const target = await db.admin.findUnique({ where: { id } });
  if (!target) throw new NotFoundError('Account not found');
  if (
    target.role === 'OWNER' &&
    data.role !== 'OWNER' &&
    target.active &&
    !(await activeOwnerCount(db, id))
  ) {
    throw new HttpError(409, 'There must always be at least one active owner.');
  }
  if (id === actorId && data.role !== target.role) {
    throw new HttpError(409, 'You can’t change your own role. Ask another owner.');
  }
  return db.admin.update({ where: { id }, data });
}

async function setActive(id, active, { actorId, db = prisma } = {}) {
  const target = await db.admin.findUnique({ where: { id } });
  if (!target) throw new NotFoundError('Account not found');
  if (!active && id === actorId) throw new HttpError(409, 'You can’t deactivate your own account.');
  if (!active && target.role === 'OWNER' && !(await activeOwnerCount(db, id))) {
    throw new HttpError(409, 'There must always be at least one active owner.');
  }
  const updated = await db.admin.update({
    where: { id },
    data: { active, failedLoginCount: 0, lockedUntil: null },
  });
  if (!active) await endSessions(id, { db });
  return updated;
}

async function resetPassword(id, password, { db = prisma } = {}) {
  checkPassword(password);
  const target = await db.admin.findUnique({ where: { id } });
  if (!target) throw new NotFoundError('Account not found');
  await db.admin.update({
    where: { id },
    data: { passwordHash: await hashPassword(password), failedLoginCount: 0, lockedUntil: null },
  });
  await endSessions(id, { db });
}

async function changeOwnPassword(id, { current, password, confirm }, { sid, db = prisma } = {}) {
  const admin = await db.admin.findUnique({ where: { id } });
  if (!admin) throw new NotFoundError('Account not found');
  if (!(await bcrypt.compare(String(current || ''), admin.passwordHash))) {
    throw new ValidationError('Your current password is wrong.', [
      { path: 'current', message: 'That isn’t your current password.' },
    ]);
  }
  checkPassword(password);
  if (password !== confirm)
    throw new ValidationError('The new passwords don’t match.', [
      { path: 'confirm', message: 'Doesn’t match.' },
    ]);
  if (await bcrypt.compare(password, admin.passwordHash)) {
    throw new ValidationError('Choose a password you haven’t used here.', [
      { path: 'password', message: 'Same as the current one.' },
    ]);
  }
  await db.admin.update({ where: { id }, data: { passwordHash: await hashPassword(password) } });
  await endSessions(id, { keepSid: sid, db }); // sign out other devices
}

module.exports = {
  ROLES,
  listAdmins,
  createAdmin,
  updateAdmin,
  setActive,
  resetPassword,
  changeOwnPassword,
  endSessions,
};
