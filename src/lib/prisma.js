const { PrismaClient } = require('@prisma/client');

// One client per process; reused across hot reloads in development.
const globalForPrisma = globalThis;
const prisma = globalForPrisma.__prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.__prisma = prisma;

module.exports = prisma;
