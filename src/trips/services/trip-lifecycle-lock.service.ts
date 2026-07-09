import { Injectable } from '@nestjs/common';
import { TripId, tripIdKey } from '../utils/trip-id.util';

/** Short-lived in-flight lock to prevent concurrent PATCH races per trip. */
@Injectable()
export class TripLifecycleLockService {
  private readonly locks = new Set<string>();

  private key(tripId: TripId): string {
    return tripIdKey(tripId);
  }

  tryAcquire(tripId: TripId): boolean {
    const key = this.key(tripId);
    if (this.locks.has(key)) {
      return false;
    }
    this.locks.add(key);
    return true;
  }

  release(tripId: TripId): void {
    this.locks.delete(this.key(tripId));
  }
}
