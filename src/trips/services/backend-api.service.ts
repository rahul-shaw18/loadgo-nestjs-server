import { Injectable, Logger } from '@nestjs/common';
import {
  BACKEND_BASE_URL,
  BACKEND_ENDPOINTS,
  BACKEND_SERVICE_TOKEN,
  TRIP_LOOKUP_CACHE_TTL_MS,
  TRIP_STATUS,
} from '../../config/app.config';
import { normalizeTripId, TripId, tripIdKey } from '../utils/trip-id.util';
import {
  extractActiveTripId as parseActiveTripId,
  extractTripStatus,
  parseTripStatus,
} from '../utils/trip-record.util';

export interface DriverLocationPayload {
  tripId: TripId;
  driverId: string | number;
  latitude: number;
  longitude: number;
  heading?: number;
  speed?: number;
  timestamp: number;
}

export interface UpdateTripStatusParams {
  tripId: TripId;
  status: number;
  driverId?: string | number;
  userId?: string | number;
  reason?: string;
  vehicleNo?: string;
  driversFeedback?: string;
  usersRating?: number;
  lat?: string;
  lng?: string;
}

const STATUS_LABELS: Record<number, string> = {
  [TRIP_STATUS.ACCEPTED]: 'ACCEPTED',
  [TRIP_STATUS.STARTED]: 'STARTED',
  [TRIP_STATUS.COMPLETED]: 'COMPLETED',
  [TRIP_STATUS.CANCELLED_BY_USER]: 'CANCELLED_BY_USER',
  [TRIP_STATUS.CANCELLED_BY_DRIVER]: 'CANCELLED_BY_DRIVER',
};

interface LiveTripRecord {
  tripId?: unknown;
  trip_id?: unknown;
  id?: unknown;
  status?: unknown;
  trip_status?: unknown;
  driverId?: unknown;
  userId?: unknown;
}

@Injectable()
export class BackendApiService {
  private readonly logger = new Logger(BackendApiService.name);
  private readonly participantLookupCache = new Map<
    string,
    { data: TripId | null; at: number }
  >();
  private readonly tripStatusCache = new Map<
    string,
    { data: number | null; at: number }
  >();

  invalidateTripCache(tripId: TripId): void {
    this.tripStatusCache.delete(tripIdKey(tripId));
    this.participantLookupCache.clear();
    this.logger.debug(`Invalidated trip lookup cache for trip ${tripIdKey(tripId)}`);
  }

  private readCache<T>(
    cache: Map<string, { data: T; at: number }>,
    key: string,
  ): T | undefined {
    const entry = cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.at >= TRIP_LOOKUP_CACHE_TTL_MS) {
      cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  private writeCache<T>(
    cache: Map<string, { data: T; at: number }>,
    key: string,
    data: T,
  ): void {
    cache.set(key, { data, at: Date.now() });
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (BACKEND_SERVICE_TOKEN) {
      headers.Authorization = `Bearer ${BACKEND_SERVICE_TOKEN}`;
    }

    return headers;
  }

  private async request<T>(
    path: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; data?: T; status?: number; rawBody?: string }> {
    try {
      const res = await fetch(`${BACKEND_BASE_URL}${path}`, {
        ...init,
        headers: {
          ...this.buildHeaders(),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
      const responseText = await res.text();

      if (res.status === 204) {
        return { ok: true, status: 204 };
      }

      let parsed: T | undefined;
      if (responseText) {
        try {
          parsed = JSON.parse(responseText) as T;
        } catch {
          parsed = undefined;
        }
      }

      if (!res.ok) {
        this.logger.warn(
          `${path} returned HTTP ${res.status}: ${responseText || '(empty)'}`,
        );
        return { ok: false, status: res.status, data: parsed, rawBody: responseText };
      }

      if (!responseText) {
        return { ok: true };
      }

      if (parsed === undefined) {
        this.logger.warn(`${path} returned non-JSON response`);
        return { ok: true, rawBody: responseText };
      }

      return { ok: true, data: parsed, rawBody: responseText };
    } catch (err) {
      this.logger.error(`${path} request failed: ${(err as Error).message}`);
      return { ok: false };
    }
  }

  private isSuccessResponse(data: unknown): boolean {
    if (!data || typeof data !== 'object') {
      return true;
    }

    const record = data as Record<string, unknown>;
    if (record.success === true || record.status === 'success') {
      return true;
    }

    if (typeof record.message === 'string') {
      const message = record.message.toLowerCase();
      return (
        message.includes('successfully') ||
        message.includes('updated successfully')
      );
    }

    return false;
  }

  async updateTripStatus(params: UpdateTripStatusParams): Promise<boolean> {
    const {
      tripId,
      status,
      driverId,
      userId,
      reason,
      vehicleNo,
      driversFeedback,
      usersRating,
      lat,
      lng,
    } = params;
    const statusLabel = STATUS_LABELS[status] ?? `STATUS_${status}`;

    const requiresCoordinates =
      status === TRIP_STATUS.STARTED || status === TRIP_STATUS.COMPLETED;

    if (requiresCoordinates && (!lat || !lng)) {
      this.logger.warn(
        `[backend] updateTripStatus(${statusLabel}) missing lat/lng for trip ${tripId}`,
      );
      return false;
    }

    let body: Record<string, unknown>;

    if (requiresCoordinates) {
      body = {
        id: tripId,
        status,
        lat,
        lng,
      };
    } else {
      body = {
        id: tripId,
        status: String(status),
      };
      if (driverId !== undefined) body.driverId = driverId;
      if (userId !== undefined) body.userId = userId;
      if (reason !== undefined) body.reason = reason;
      if (vehicleNo !== undefined) body.vehicleNo = vehicleNo;
      if (driversFeedback !== undefined) body.driversFeedback = driversFeedback;
      if (usersRating !== undefined) body.usersRating = usersRating;
    }

    const requestBody = JSON.stringify(body);

    const result = await this.request<Record<string, unknown>>(
      BACKEND_ENDPOINTS.PATCH_LIVE_TRIP,
      {
        method: 'PATCH',
        body: requestBody,
      },
    );

    if (!result.ok) {
      this.logger.warn(
        `[backend] updateTripStatus(${statusLabel}) failed for trip ${tripId} — ` +
          `request=${requestBody} response=${result.rawBody ?? JSON.stringify(result.data ?? null)}`,
      );
      return false;
    }

    const success = result.data ? this.isSuccessResponse(result.data) : true;
    if (!success) {
      this.logger.warn(
        `[backend] updateTripStatus(${statusLabel}) rejected for trip ${tripId} — ` +
          `request=${requestBody} response=${result.rawBody ?? JSON.stringify(result.data)}`,
      );
    } else {
      this.logger.log(
        `[backend] updateTripStatus(${statusLabel}) succeeded for trip ${tripId} — request=${requestBody}`,
      );
      this.invalidateTripCache(tripId);
    }

    return success;
  }

  async confirmTripAcceptance(
    tripId: TripId,
    driverId: string | number,
  ): Promise<boolean> {
    return this.updateTripStatus({
      tripId,
      status: TRIP_STATUS.ACCEPTED,
      driverId,
    });
  }

  persistDriverLocation(payload: DriverLocationPayload): void {
    void this.request(BACKEND_ENDPOINTS.PATCH_DRIVER, {
      method: 'PATCH',
      body: JSON.stringify({
        id: payload.driverId,
        lat: payload.latitude,
        lng: payload.longitude,
      }),
    }).then((result) => {
      if (!result.ok) {
        this.logger.debug(
          `Driver location persistence failed for driver ${payload.driverId}`,
        );
      }
    });
  }

  private async fetchActiveTrip(query: {
    driverId?: string | number;
    userId?: string | number;
  }): Promise<TripId | null> {
    const cacheKey = query.driverId
      ? `driver:${String(query.driverId)}`
      : `user:${String(query.userId)}`;

    const cached = this.readCache(this.participantLookupCache, cacheKey);
    if (cached !== undefined) {
      this.logger.debug(
        `[backend] getLiveTripData cache hit (${cacheKey}) → ${cached ?? 'none'}`,
      );
      return cached;
    }

    const param = query.driverId
      ? `driverId=${encodeURIComponent(String(query.driverId))}`
      : `userId=${encodeURIComponent(String(query.userId))}`;

    const result = await this.request<Record<string, unknown>>(
      `${BACKEND_ENDPOINTS.GET_LIVE_TRIP}?${param}`,
      { method: 'GET' },
    );

    if (!result.ok || !result.data) {
      this.logger.debug(
        `[backend] getLiveTripData (${param}) — no response or HTTP error`,
      );
      return null;
    }

    const activeTripId = parseActiveTripId(result.data, query);
    this.writeCache(this.participantLookupCache, cacheKey, activeTripId);
    if (activeTripId) {
      const trips = Array.isArray(
        (result.data as Record<string, unknown>).data,
      )
        ? (result.data as Record<string, unknown>).data
        : [result.data];
      const matched = (trips as LiveTripRecord[]).find((trip) => {
        const tripId =
          normalizeTripId(trip?.tripId) ??
          normalizeTripId(trip?.trip_id) ??
          normalizeTripId(trip?.id);
        return tripId !== null && String(tripId) === String(activeTripId);
      });
      const status = matched
        ? parseTripStatus(matched as Record<string, unknown>)
        : null;
      this.logger.log(
        `[backend] getLiveTripData (${param}) → active trip ${activeTripId} (status ${status ?? 'unknown'})`,
      );
    } else {
      this.logger.log(
        `[backend] getLiveTripData (${param}) → no active trip (status 2 or 4)`,
      );
    }

    return activeTripId;
  }

  async fetchDriverActiveTrip(
    driverId: string | number,
  ): Promise<TripId | null> {
    return this.fetchActiveTrip({ driverId });
  }

  async fetchUserActiveTrip(userId: string | number): Promise<TripId | null> {
    return this.fetchActiveTrip({ userId });
  }

  async fetchTripStatus(tripId: TripId): Promise<number | null> {
    const cacheKey = tripIdKey(tripId);
    const cached = this.readCache(this.tripStatusCache, cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const param = `id=${encodeURIComponent(String(tripId))}`;

    const result = await this.request<Record<string, unknown>>(
      `${BACKEND_ENDPOINTS.GET_LIVE_TRIP}?${param}`,
      { method: 'GET' },
    );

    if (!result.ok || !result.data) {
      this.logger.debug(
        `[backend] getLiveTripData (${param}) — no response for status check`,
      );
      return null;
    }

    const status = extractTripStatus(result.data, tripId);
    this.writeCache(this.tripStatusCache, cacheKey, status);
    this.logger.log(
      `[backend] getLiveTripData (${param}) → status ${status ?? 'unknown'}`,
    );
    return status;
  }
}
