import { Injectable } from '@nestjs/common';
import { DriverLocationPayload } from './backend-api.service';
import { TripId, tripIdKey } from '../utils/trip-id.util';

@Injectable()
export class LocationCacheService {
  private readonly lastLocationByTrip = new Map<string, DriverLocationPayload>();

  set(tripId: TripId, location: DriverLocationPayload): void {
    this.lastLocationByTrip.set(tripIdKey(tripId), location);
  }

  get(tripId: TripId): DriverLocationPayload | null {
    return this.lastLocationByTrip.get(tripIdKey(tripId)) ?? null;
  }

  clear(tripId: TripId): void {
    this.lastLocationByTrip.delete(tripIdKey(tripId));
  }
}
