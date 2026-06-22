import { Injectable, Logger } from '@nestjs/common';
import {
  ACTIVE_TRIP_STATUSES,
  BACKEND_BASE_URL,
  BACKEND_ENDPOINTS,
  BACKEND_SERVICE_TOKEN,
  TRIP_STATUS,
} from '../../config/app.config';
import { normalizeTripId, TripId } from '../utils/trip-id.util';

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
}

@Injectable()
export class BackendApiService {
  private readonly logger = new Logger(BackendApiService.name);

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
  ): Promise<{ ok: boolean; data?: T; status?: number }> {
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

      if (!res.ok) {
        this.logger.warn(`${path} returned HTTP ${res.status}`);
        return { ok: false, status: res.status };
      }

      if (!responseText) {
        return { ok: true };
      }

      try {
        return { ok: true, data: JSON.parse(responseText) as T };
      } catch {
        this.logger.warn(`${path} returned non-JSON response`);
        return { ok: true };
      }
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
        message.includes('successfully') || message.includes('updated successfully')
      );
    }

    return false;
  }

  private extractTripIdFromRecord(record: LiveTripRecord | null): TripId | null {
    if (!record) {
      return null;
    }

    return (
      normalizeTripId(record.tripId) ??
      normalizeTripId(record.trip_id) ??
      normalizeTripId(record.id)
    );
  }

  private extractActiveTripId(data: unknown): TripId | null {
    if (!data || typeof data !== 'object') {
      return null;
    }

    const record = data as Record<string, unknown>;
    const trips = Array.isArray(record.data) ? record.data : [record.data ?? record];

    for (const trip of trips) {
      if (!trip || typeof trip !== 'object') {
        continue;
      }

      const tripRecord = trip as LiveTripRecord;
      const status = Number(tripRecord.status);
      const tripId = this.extractTripIdFromRecord(tripRecord);

      if (
        tripId &&
        ACTIVE_TRIP_STATUSES.includes(
          status as (typeof ACTIVE_TRIP_STATUSES)[number],
        )
      ) {
        return tripId;
      }
    }

    return null;
  }

  async updateTripStatus(params: UpdateTripStatusParams): Promise<boolean> {
    const { tripId, status, driverId, userId, reason } = params;
    const statusLabel = STATUS_LABELS[status] ?? `STATUS_${status}`;

    const body: Record<string, unknown> = {
      id: tripId,
      status,
    };
    if (driverId !== undefined) body.driverId = driverId;
    if (userId !== undefined) body.userId = userId;
    if (reason !== undefined) body.reason = reason;

    const result = await this.request<Record<string, unknown>>(
      BACKEND_ENDPOINTS.PATCH_LIVE_TRIP,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    );

    if (!result.ok) {
      this.logger.warn(
        `[backend] updateTripStatus(${statusLabel}) failed for trip ${tripId} — HTTP ${result.status ?? 'error'}`,
      );
      return false;
    }

    const success = result.data ? this.isSuccessResponse(result.data) : true;
    if (!success) {
      this.logger.warn(
        `[backend] updateTripStatus(${statusLabel}) rejected for trip ${tripId} — response=${JSON.stringify(result.data)}`,
      );
    } else {
      this.logger.log(
        `[backend] updateTripStatus(${statusLabel}) succeeded for trip ${tripId}`,
      );
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
    const param = query.driverId
      ? `driverId=${encodeURIComponent(String(query.driverId))}`
      : `userId=${encodeURIComponent(String(query.userId))}`;

    const result = await this.request<Record<string, unknown>>(
      `${BACKEND_ENDPOINTS.GET_LIVE_TRIP}?${param}`,
      { method: 'GET' },
    );

    if (!result.ok || !result.data) {
      return null;
    }

    const activeTripId = this.extractActiveTripId(result.data);
    if (!activeTripId) {
      this.logger.debug(
        `No active trip (status 2 or 4) found for ${param}`,
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
}
