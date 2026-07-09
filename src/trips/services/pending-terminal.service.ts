import { Injectable, Logger } from '@nestjs/common';
import { PENDING_TERMINAL_COOLDOWN_MS } from '../../config/app.config';
import { TripId, tripIdKey } from '../utils/trip-id.util';

interface PendingTerminalAttempt {
  tripId: TripId;
  status: number;
  at: number;
}

/** In-memory, single-instance only — move to Redis if horizontally scaled. */
@Injectable()
export class PendingTerminalService {
  private readonly logger = new Logger(PendingTerminalService.name);
  private readonly attempts = new Map<string, PendingTerminalAttempt>();

  private key(driverId: string | number, tripId: TripId): string {
    return `${String(driverId)}:${tripIdKey(tripId)}`;
  }

  recordAttempt(
    driverId: string | number,
    tripId: TripId,
    status: number,
  ): void {
    const mapKey = this.key(driverId, tripId);
    this.attempts.set(mapKey, { tripId, status, at: Date.now() });
    this.logger.warn(
      `Pending terminal attempt recorded driver=${driverId} trip=${tripIdKey(tripId)} status=${status}`,
    );
  }

  isBlocked(driverId: string | number, tripId: TripId): boolean {
    const entry = this.attempts.get(this.key(driverId, tripId));
    if (!entry) {
      return false;
    }

    if (Date.now() - entry.at >= PENDING_TERMINAL_COOLDOWN_MS) {
      this.attempts.delete(this.key(driverId, tripId));
      return false;
    }

    return true;
  }

  clearAttempt(driverId: string | number, tripId: TripId): void {
    this.attempts.delete(this.key(driverId, tripId));
  }

  clearAllForDriver(driverId: string | number): void {
    const prefix = `${String(driverId)}:`;
    for (const mapKey of [...this.attempts.keys()]) {
      if (mapKey.startsWith(prefix)) {
        this.attempts.delete(mapKey);
      }
    }
  }
}
