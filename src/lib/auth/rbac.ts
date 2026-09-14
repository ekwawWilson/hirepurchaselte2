import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../db/prisma';
import { verifyToken } from './jwt';
import { OWN_SCOPED_ROLES, type Permission, type RoleName } from '../constants/rbac';
import type { AuthenticatedUser } from './types';

/**
 * Verifies the bearer JWT and loads the user (with role + permissions) fresh
 * from the DB on every request — not just once at login — so a role change
 * or deactivation takes effect immediately rather than waiting for the token
 * to expire. Call at the top of every route handler that needs auth.
 */
export async function requireAuth(req: NextRequest): Promise<{ user: AuthenticatedUser } | { error: NextResponse }> {
  const header = req.headers.get('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return { error: NextResponse.json({ error: 'Missing or invalid Authorization header' }, { status: 401 }) };
  }

  try {
    const token = header.slice('Bearer '.length);
    const payload = verifyToken(token);
    // A customer portal token authenticates a customer, never a staff user.
    if (payload.typ === 'customer') {
      return { error: NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 }) };
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { role: { include: { permissions: true } } },
    });

    if (!user || !user.isActive) {
      return { error: NextResponse.json({ error: 'Invalid or inactive account' }, { status: 401 }) };
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        roleId: user.roleId,
        roleName: user.role.name as RoleName,
        branchId: user.branchId,
        permissions: user.role.permissions.map((p) => p.name) as Permission[],
      },
    };
  } catch {
    return { error: NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 }) };
  }
}

/** OR-semantics permission check: passes if the user holds ANY of the listed permissions. SUPER_ADMIN always passes. */
export function requirePermission(
  user: AuthenticatedUser,
  ...perms: Permission[]
): { authorized: true } | { authorized: false; error: NextResponse } {
  if (user.roleName === 'SUPER_ADMIN' || perms.some((p) => user.permissions.includes(p))) {
    return { authorized: true };
  }
  return { authorized: false, error: NextResponse.json({ error: 'Forbidden: missing required permission' }, { status: 403 }) };
}

export function requireSuperAdmin(user: AuthenticatedUser): { authorized: true } | { authorized: false; error: NextResponse } {
  if (user.roleName === 'SUPER_ADMIN') return { authorized: true };
  return { authorized: false, error: NextResponse.json({ error: 'Forbidden: super admin only' }, { status: 403 }) };
}

/** Branch scoping, server-side only — never trust a client-supplied branch filter. null branchId = sees all branches. */
export function branchScopeWhere(user: AuthenticatedUser): { branchId?: string } {
  return user.branchId ? { branchId: user.branchId } : {};
}

/** Single-record equivalent of branchScopeWhere — fails closed if the record's branch doesn't match. */
export function assertBranchAccess(user: AuthenticatedUser, resourceBranchId: string): boolean {
  if (!user.branchId) return true;
  return user.branchId === resourceBranchId;
}

/**
 * On top of branch scoping, an OWN_SCOPED_ROLES user (currently just AGENT)
 * is further restricted to records they themselves created — see that
 * constant's comment. Spread alongside branchScopeWhere: `{ ...branchScopeWhere(user), ...ownRecordsWhere(user) }`.
 * Empty for every other role.
 */
export function ownRecordsWhere(user: AuthenticatedUser): { createdById?: string } {
  return OWN_SCOPED_ROLES.includes(user.roleName) ? { createdById: user.id } : {};
}

/** Single-record equivalent of ownRecordsWhere — fails closed if the record wasn't created by this user. */
export function assertOwnRecordAccess(user: AuthenticatedUser, resourceCreatedById: string): boolean {
  if (!OWN_SCOPED_ROLES.includes(user.roleName)) return true;
  return user.id === resourceCreatedById;
}
