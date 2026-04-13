import { Injectable, Logger } from '@nestjs/common';
import { BACKGROUND_TIMER_MS } from '../../config/app.config';

interface QueueEntry {
  tripId: number;
  addedAt: number;
  bgExpireAt: number;
}

@Injectable()
export class DriverQueueService {
  private readonly logger = new Logger(DriverQueueService.name);

  // State: driverId -> array of QueueEntry
  private driverQueues: Record<string, QueueEntry[]> = {};

  // ─── Internal helpers ───
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
      this.logger.log(
        `Purged ${removed} expired trip(s) from driver ${id}'s queue`,
      );
    }
  }

  // ─── Public API ───
  addTripToDriver(driverId: string | number, tripId: number): boolean {
    const id = String(driverId);
    if (!this.driverQueues[id]) {
      this.driverQueues[id] = [];
    }

    if (this.driverQueues[id].some((entry) => Number(entry.tripId) === Number(tripId))) {
      return false;
    }

    const now = Date.now();
    this.driverQueues[id].push({
      tripId,
      addedAt: now,
      bgExpireAt: now + BACKGROUND_TIMER_MS,
    });

    this.logger.log(
      `Trip ${tripId} added to driver ${id}'s queue (queue size: ${this.driverQueues[id].length})`,
    );
    return true;
  }

  removeTripFromDriver(driverId: string | number, tripId: number) {
    const id = String(driverId);
    if (!this.driverQueues[id]) return;
    this.driverQueues[id] = this.driverQueues[id].filter(
      (entry) => Number(entry.tripId) !== Number(tripId),
    );
  }

  removeTripFromAllDrivers(tripId: number): string[] {
    const affectedDrivers: string[] = [];

    for (const driverId of Object.keys(this.driverQueues)) {
      const hadTrip = this.driverQueues[driverId].some(
        (entry) => Number(entry.tripId) === Number(tripId),
      );

      if (hadTrip) {
        this.driverQueues[driverId] = this.driverQueues[driverId].filter(
          (entry) => Number(entry.tripId) !== Number(tripId),
        );
        affectedDrivers.push(driverId);
      }
    }

    if (affectedDrivers.length > 0) {
      this.logger.log(
        `Trip ${tripId} removed from ${affectedDrivers.length} driver queue(s)`,
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

  rotateCurrentTrip(driverId: string | number): QueueEntry | null {
    const id = String(driverId);
    if (!this.driverQueues[id] || this.driverQueues[id].length === 0) {
      return null;
    }

    const current = this.driverQueues[id].shift();

    if (current && current.bgExpireAt > Date.now()) {
      this.driverQueues[id].push(current);
    } else {
      this.logger.log(
        `Trip ${current?.tripId} expired during rotation for driver ${id}`,
      );
    }

    this.purgeExpired(id);
    return this.driverQueues[id][0] || null;
  }

  getQueue(driverId: string | number): QueueEntry[] {
    const id = String(driverId);
    this.purgeExpired(id);
    return this.driverQueues[id] || [];
  }

  getQueueSize(driverId: string | number): number {
    const id = String(driverId);
    this.purgeExpired(id);
    return (this.driverQueues[id] || []).length;
  }

  hasTripInQueue(driverId: string | number, tripId: number): boolean {
    const id = String(driverId);
    if (!this.driverQueues[id]) return false;
    return this.driverQueues[id].some((entry) => Number(entry.tripId) === Number(tripId));
  }

  clearDriver(driverId: string | number) {
    const id = String(driverId);
    delete this.driverQueues[id];
    this.logger.log(`Queue cleared for driver ${id}`);
  }

  getDriversWithTrip(tripId: number): string[] {
    return Object.keys(this.driverQueues).filter(
      (driverId) =>
        this.driverQueues[driverId] &&
        this.driverQueues[driverId].some((entry) => Number(entry.tripId) === Number(tripId)),
    );
  }
}
