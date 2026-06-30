// DEPRECATED — moved to /api/orders/[id]/drawings/route.js
import { NextResponse } from 'next/server';
export async function GET() { return NextResponse.json({ error: 'Moved to /api/orders/[id]/drawings' }, { status: 410 }); }
export async function POST() { return NextResponse.json({ error: 'Moved to /api/orders/[id]/drawings' }, { status: 410 }); }
export async function DELETE() { return NextResponse.json({ error: 'Moved to /api/orders/[id]/drawings' }, { status: 410 }); }
