import dotenv from 'dotenv';
import { beforeAll } from 'vitest';

// Must run before any test file imports route handlers (which import
// lib/db/prisma, lib/auth/jwt, etc. — all of which read process.env at
// module load or call time).
dotenv.config();

// Hard block on real outbound network calls for the whole suite. .env holds
// real live Hubtel merchant credentials for local live-mode use, and a test
// that flips HUBTEL_PAYMENTS_MODE to 'live' must never be able to reach
// Hubtel's real API with them — deleting the credential env vars here was
// tried first and was NOT reliable (something in the module graph, most
// likely Next's own env loading, can repopulate process.env after this file
// runs), so the call itself is blocked instead.
//
// Deliberately a PLAIN assignment, not vi.stubGlobal — this must survive every
// test's own cleanup. If this were installed via vi.stubGlobal, a test that
// calls vi.stubGlobal('fetch', ...) for its own mock and later
// vi.unstubAllGlobals() could restore Vitest's ORIGINAL (real) fetch instead
// of this guard, silently removing the block. A test that needs to exercise a
// live-mode HTTP path must save `globalThis.fetch` (which will be this guard),
// install its own mock, and restore the saved guard in a finally — never rely
// on vi.unstubAllGlobals() for this. See tests/ussd-and-hubtel.test.ts.
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  throw new Error(
    `Blocked outbound network call in tests: ${String(args[0])}. ` +
    `Tests must never hit the real network — save globalThis.fetch (the guard), install ` +
    `your own mock, and restore the saved guard in a finally block.`,
  );
}) as typeof fetch;

// Reversals, write-offs and paid-up cancellations wait for a second person by
// default (Settings > Controls). Every test file starts with that control
// off — whatever an earlier file left it at — so the many tests of those
// actions themselves see them happen at once; tests/security-controls.test.ts
// turns it on to test the control.
beforeAll(async () => {
  const { setSecondApproval } = await import('./helpers');
  await setSecondApproval(false);
});
