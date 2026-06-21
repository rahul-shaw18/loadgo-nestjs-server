export type TripId = string | number;

export function normalizeTripId(id: unknown): TripId | null {
  if (id === undefined || id === null || id === '') {
    return null;
  }

  if (typeof id === 'string') {
    const trimmed = id.trim();
    if (!trimmed) {
      return null;
    }

    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && asNumber > 0 && String(asNumber) === trimmed) {
      return asNumber;
    }

    return trimmed;
  }

  if (typeof id === 'number' && Number.isFinite(id) && id > 0) {
    return id;
  }

  return null;
}

export function tripIdKey(id: TripId): string {
  return String(id);
}

export function tripIdsEqual(a: TripId, b: TripId): boolean {
  return tripIdKey(a) === tripIdKey(b);
}
