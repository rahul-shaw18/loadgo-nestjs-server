import { ACTIVE_TRIP_STATUSES } from '../../config/app.config';
import { normalizeTripId, TripId } from './trip-id.util';

const STATUS_FIELDS = [
  'status',
  'trip_status',
  'tripStatus',
  'ride_status',
  'rideStatus',
] as const;

const DRIVER_FIELDS = [
  'driverId',
  'driver_id',
  'assignedDriverId',
  'assigned_driver_id',
] as const;

const USER_FIELDS = [
  'userId',
  'user_id',
  'customerId',
  'customer_id',
] as const;

const TRIP_ID_FIELDS = ['tripId', 'trip_id', 'id', 'liveTripId'] as const;

export function parseTripStatus(record: Record<string, unknown>): number | null {
  for (const field of STATUS_FIELDS) {
    const raw = record[field];
    if (raw === undefined || raw === null || raw === '') {
      continue;
    }

    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber;
    }

    const label = String(raw).toLowerCase();
    if (
      label === 'requested' ||
      label === 'pending' ||
      label === 'searching' ||
      label.includes('search')
    ) {
      return 1;
    }
    if (label === 'accepted' || label.includes('assigned')) {
      return 2;
    }
    if (label === 'revoked' || label === 'cancelled_timeout') {
      return 3;
    }
    if (label === 'started' || label.includes('in progress')) {
      return 4;
    }
    if (label === 'completed' || label === 'complete') {
      return 5;
    }
    if (label.includes('cancel') && label.includes('user')) {
      return 6;
    }
    if (label.includes('cancel') && label.includes('driver')) {
      return 7;
    }
    if (label.includes('timeout') || label.includes('expired')) {
      return 8;
    }
  }

  return null;
}

function readParticipantId(
  record: Record<string, unknown>,
  fields: readonly string[],
): string | number | null {
  for (const field of fields) {
    const value = record[field];
    if (value !== undefined && value !== null && value !== '') {
      return value as string | number;
    }
  }

  return null;
}

export function extractTripIdFromRecord(
  record: Record<string, unknown>,
): TripId | null {
  for (const field of TRIP_ID_FIELDS) {
    const tripId = normalizeTripId(record[field]);
    if (tripId) {
      return tripId;
    }
  }

  return null;
}

function flattenTripRecords(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== 'object') {
    return [];
  }

  const record = data as Record<string, unknown>;

  if ('data' in record) {
    if (Array.isArray(record.data)) {
      return record.data.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object',
      );
    }

    if (record.data && typeof record.data === 'object') {
      return [record.data as Record<string, unknown>];
    }

    return [];
  }

  if (
    extractTripIdFromRecord(record) !== null &&
    parseTripStatus(record) !== null
  ) {
    return [record];
  }

  return [];
}

export interface ActiveTripQuery {
  driverId?: string | number;
  userId?: string | number;
}

export function extractActiveTripId(
  data: unknown,
  query: ActiveTripQuery,
): TripId | null {
  const trips = flattenTripRecords(data);

  for (const trip of trips) {
    const tripId = extractTripIdFromRecord(trip);
    const status = parseTripStatus(trip);

    if (!tripId || status === null) {
      continue;
    }

    if (
      !ACTIVE_TRIP_STATUSES.includes(
        status as (typeof ACTIVE_TRIP_STATUSES)[number],
      )
    ) {
      continue;
    }

    if (query.driverId !== undefined) {
      const assignedDriver = readParticipantId(trip, DRIVER_FIELDS);
      if (
        assignedDriver !== null &&
        String(assignedDriver) !== String(query.driverId)
      ) {
        continue;
      }
    }

    if (query.userId !== undefined) {
      const assignedUser = readParticipantId(trip, USER_FIELDS);
      if (
        assignedUser !== null &&
        String(assignedUser) !== String(query.userId)
      ) {
        continue;
      }
    }

    return tripId;
  }

  return null;
}

export function extractTripStatus(
  data: unknown,
  tripId?: TripId,
): number | null {
  const trips = flattenTripRecords(data);

  if (tripId !== undefined) {
    for (const trip of trips) {
      const id = extractTripIdFromRecord(trip);
      if (id !== null && String(id) === String(tripId)) {
        return parseTripStatus(trip);
      }
    }
    return null;
  }

  if (trips.length === 1) {
    return parseTripStatus(trips[0]);
  }

  return null;
}

const FARE_FIELDS = [
  'fare',
  'updatedFare',
  'updated_fare',
  'tripFare',
  'trip_fare',
  'amount',
  'price',
  'totalFare',
  'total_fare',
] as const;

export function extractTripFare(
  data: unknown,
  tripId?: TripId,
): number | string | null {
  const trips = flattenTripRecords(data);
  const records =
    tripId !== undefined
      ? trips.filter((trip) => {
          const id = extractTripIdFromRecord(trip);
          return id !== null && String(id) === String(tripId);
        })
      : trips;

  for (const trip of records) {
    for (const field of FARE_FIELDS) {
      const raw = trip[field];
      if (raw === undefined || raw === null || raw === '') {
        continue;
      }
      const asNumber = Number(raw);
      if (Number.isFinite(asNumber)) {
        return asNumber;
      }
      return String(raw);
    }
  }

  return null;
}

export function extractTripRecord(
  data: unknown,
  tripId: TripId,
): Record<string, unknown> | null {
  const trips = flattenTripRecords(data);
  for (const trip of trips) {
    const id = extractTripIdFromRecord(trip);
    if (id !== null && String(id) === String(tripId)) {
      return trip;
    }
  }
  return trips.length === 1 ? trips[0] : null;
}
