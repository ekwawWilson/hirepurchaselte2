import { NextResponse } from 'next/server';

/**
 * Resetting a forgotten password with a texted code is switched off: staff
 * reset it to the customer's phone number instead (customers/[id]/portal-password).
 * Kept answering so customer apps already installed show why.
 */
export async function POST() {
  return NextResponse.json({ error: 'To reset your password, ask at the shop or call us. It will be set back to your phone number.' }, { status: 410 });
}
