import dotenv from 'dotenv';

// Must run before any test file imports route handlers (which import
// lib/db/prisma, lib/auth/jwt, etc. — all of which read process.env at
// module load or call time).
dotenv.config();
