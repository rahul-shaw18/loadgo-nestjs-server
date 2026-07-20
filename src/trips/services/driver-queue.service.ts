import { Injectable, Logger } from '@nestjs/common';
import { BACKGROUND_TIMER_MS } from '../../config/app.config';
import { TripId, tripIdKey, tripIdsEqual } from '../utils/trip-id.util';

export interface QueueEntry {
  tripId: TripId;
  addedAt: number;
  bgExpireAt: number;
}

@Injectable()
export class DriverQueueService {
  private readonly logger = new Logger(DriverQueueService.name);

  private driverQueues: Record<string, QueueEntry[]> = {};

  private purgeExpired(driverId: string | number) {
    const id = String(driverId);
    if (!this.driverQueues[id]) return;

    const now = Date.now();
    const before = this.driverQueues[id].length;

    this.driverQueues[id] = this.driverQueues[id].filter(
      (entry) => entry.bgExpireAt > now,
    );

    const removed = before - this.driverQueues[id].length;
    if (removed > 0) {
      this.logQueueState(id, `Purged ${removed} expired trip(s)`);
    }
  }

  private formatQueueLines(driverId: string | number): string {
    const ids = this.getQueueTripIds(driverId);
    if (ids.length === 0) {
      return '(empty)';
    }
    return ids.map((id) => String(id)).join('\n');
  }

  logQueueState(
    driverId: string | number,
    action: string,
    tripId?: TripId,
  ): void {
    const id = String(driverId);
    const tripLine = tripId !== undefined ? `\nTrip: ${tripId}` : '';
    this.logger.log(
      `[DriverQueue] Driver ${id}\n${action}${tripLine}\n\nQueue:\n${this.formatQueueLines(id)}`,
    );
  }

  getQueueTripIds(driverId: string | number): TripId[] {
    const id = String(driverId);
    this.purgeExpired(id);
    return (this.driverQueues[id] ?? []).map((entry) => entry.tripId);
  }

  addTripToDriver(driverId: string | number, tripId: TripId): boolean {
    const id = String(driverId);
    if (!this.driverQueues[id]) {
      this.driverQueues[id] = [];
    }

    if (this.driverQueues[id].some((entry) => tripIdsEqual(entry.tripId, tripId))) {
      this.logger.debug(
        `[DriverQueue] Driver ${id} — trip ${tripId} already queued, skipping duplicate`,
      );
      return false;
    }

    const now = Date.now();
    this.driverQueues[id].push({
      tripId,
      addedAt: now,
      bgExpireAt: now + BACKGROUND_TIMER_MS,
    });

    this.logQueueState(id, `Added Trip ${tripId}`);
    return true;
  }

  removeTripFromDriver(driverId: string | number, tripId: TripId): boolean {
    const id = String(driverId);
    if (!this.driverQueues[id]) return false;

    const before = this.driverQueues[id].length;
    this.driverQueues[id] = this.driverQueues[id].filter(
      (entry) => !tripIdsEqual(entry.tripId, tripId),
    );

    if (this.driverQueues[id].length === before) {
      return false;
    }

    this.logQueueState(id, `Removed Trip ${tripId}`);
    return true;
  }

  removeTripFromAllDrivers(tripId: TripId): string[] {
    const affectedDrivers: string[] = [];

    for (const driverId of Object.keys(this.driverQueues)) {
      if (this.removeTripFromDriver(driverId, tripId)) {
        affectedDrivers.push(driverId);
      }
    }

    if (affectedDrivers.length > 0) {
      this.logger.log(
        `[DriverQueue] Trip ${tripId} removed from ${affectedDrivers.length} driver queue(s): [${affectedDrivers.join(', ')}]`,
      );
    }

    return affectedDrivers;
  }

  getNextTrip(driverId: string | number): QueueEntry | null {
    const id = String(driverId);
    this.purgeExpired(id);

    if (!this.driverQueues[id] || this.driverQueues[id].length === 0) {
      return null;
    }
    return this.driverQueues[id][0];
  }

  /** Removes the front trip without re-queuing it (reject / screen timeout). */
  removeFrontTrip(driverId: string | number): TripId | null {
    const id = String(driverId);
    if (!this.driverQueues[id] || this.driverQueues[id].length === 0) {
      return null;
    }

    const removed = this.driverQueues[id].shift();
    if (!removed) {
      return null;
    }

    this.logQueueState(id, `Removed front Trip ${removed.tripId}`);
    return removed.tripId;
  }

  /** Moves a cooldown-hidden trip to the back so the next candidate can be tried. */
  deferFrontTrip(driverId: string | number): TripId | null {
    const id = String(driverId);
    if (!this.driverQueues[id] || this.driverQueues[id].length === 0) {
      return null;
    }

    const current = this.driverQueues[id].shift();
    if (!current) {
      return null;
    }

    if (current.bgExpireAt > Date.now()) {
      this.driverQueues[id].push(current);
    }

    return current.tripId;
  }

  getQueue(driverId: string | number): QueueEntry[] {
    const id = String(driverId);
    this.purgeExpired(id);
    return [...(this.driverQueues[id] ?? [])];
  }

  getQueueSize(driverId: string | number): number {
    const id = String(driverId);
    this.purgeExpired(id);
    return (this.driverQueues[id] ?? []).length;
  }

  hasTripInQueue(driverId: string | number, tripId: TripId): boolean {
    const id = String(driverId);
    if (!this.driverQueues[id]) return false;
    return this.driverQueues[id].some((entry) => tripIdsEqual(entry.tripId, tripId));
  }

  clearDriverQueue(driverId: string | number, reason?: string): void {
    const id = String(driverId);
    if (!this.driverQueues[id] || this.driverQueues[id].length === 0) {
      return;
    }

    delete this.driverQueues[id];
    this.logger.log(
      `[DriverQueue] Driver ${id}\n${reason ?? 'Clearing queue'}\n\nQueue:\n(empty)`,
    );
  }

  clearDriver(driverId: string | number): void {
    this.clearDriverQueue(driverId, 'Queue cleared');
  }

  getDriversWithTrip(tripId: TripId): string[] {
    return Object.keys(this.driverQueues).filter(
      (driverId) =>
        this.driverQueues[driverId] &&
        this.driverQueues[driverId].some((entry) => tripIdsEqual(entry.tripId, tripId)),
    );
  }
}
