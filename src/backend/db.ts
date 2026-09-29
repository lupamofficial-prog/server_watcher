import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({ log: [{ level: 'error', emit: 'stdout' }] });
export * from '@prisma/client';
