import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ status: 'ok', service: 'hp-lite', timestamp: new Date().toISOString() });
}
