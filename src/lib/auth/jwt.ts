import jwt from 'jsonwebtoken';

export interface JwtPayload {
  sub: string; // staff user id, or customer id for a portal token
  // Absent on staff tokens, including every token issued before the customer
  // portal existed. A staff route must reject a customer token and vice
  // versa — see requireAuth (rbac.ts) and requireCustomer (customerAuth.ts).
  typ?: 'customer';
}

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not configured');
  return s;
}

export function signToken(userId: string): string {
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  return jwt.sign({ sub: userId } as JwtPayload, secret(), { expiresIn } as jwt.SignOptions);
}

/** A portal token for a customer — never accepted by a staff route. */
export function signCustomerToken(customerId: string): string {
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  return jwt.sign({ sub: customerId, typ: 'customer' } as JwtPayload, secret(), { expiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, secret()) as JwtPayload;
}
