/**
 * Prisma `where` fragments for the search boxes. Every word typed must match
 * something ("ama 0244" finds Ama whose number contains 0244), in any case —
 * Postgres `contains` is case-sensitive unless told otherwise, which made
 * "ama" miss "Ama".
 */
const insensitive = (value: string) => ({ contains: value, mode: 'insensitive' as const });

export function searchTerms(q: string | null | undefined): string[] {
  return (q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
}

function customerMatches(term: string) {
  return [
    { firstName: insensitive(term) }, { lastName: insensitive(term) }, { membershipId: insensitive(term) },
    { phone: { contains: term } }, { phone2: { contains: term } }, { phone3: { contains: term } },
  ];
}

export function customerSearchWhere(q: string | null | undefined) {
  return searchTerms(q).map((term) => ({ OR: customerMatches(term) }));
}

export function contractSearchWhere(q: string | null | undefined) {
  return searchTerms(q).map((term) => ({
    OR: [{ contractNumber: insensitive(term) }, { customer: { OR: customerMatches(term) } }],
  }));
}

export function inventorySearchWhere(q: string | null | undefined) {
  return searchTerms(q).map((term) => ({
    OR: [
      { serialNumber: insensitive(term) }, { name: insensitive(term) }, { description: insensitive(term) },
      { product: { name: insensitive(term) } }, { product: { category: { name: insensitive(term) } } },
    ],
  }));
}
