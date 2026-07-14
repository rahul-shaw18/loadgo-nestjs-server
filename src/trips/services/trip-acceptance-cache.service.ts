import { Injectable, Logger } from '@nestjs/common';
import { TripId, tripIdKey } from '../utils/trip-id.util';

export interface TripAcceptanceRecord {
  tripId: TripId;
  driverId: string | number;
  vehicleNo?: string;
}

/**
 * In-memory acceptance state for reconnect restoration.
 * Lives for the full active-trip lifetime and is cleared only on terminal states.
 */
@Injectable()
export class TripAcceptanceCacheService {
  private readonly logger = new Logger(TripAcceptanceCacheService.name);
  private readonly acceptances = new Map<string, TripAcceptanceRecord>();

  set(record: TripAcceptanceRecord): void {
    const key = tripIdKey(record.tripId);
    this.acceptances.set(key, {
      tripId: record.tripId,
      driverId: record.driverId,
      ...(record.vehicleNo !== undefined && { vehicleNo: record.vehicleNo }),
    });
    this.logger.debug(
      `Cached acceptance for trip ${key} driver ${record.driverId}`,
    );
  }

  get(tripId: TripId): TripAcceptanceRecord | null {
    return this.acceptances.get(tripIdKey(tripId)) ?? null;
  }

  clear(tripId: TripId): void {
    const key = tripIdKey(tripId);
    if (this.acceptances.delete(key)) {
      this.logger.debug(`Cleared acceptance cache for trip ${key}`);
    }
  }
}
