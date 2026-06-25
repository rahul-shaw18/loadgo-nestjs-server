import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { REJECTION_COOLDOWN_MS } from '../../config/app.config';
import { TripId, tripIdKey } from '../utils/trip-id.util';

interface CooldownEntry {
  expiresAt: number;
  timerId: NodeJS.Timeout;
  reason?: string;
}

export type RejectionCooldownExpiredHandler = (
  driverId: string,
  tripId: TripId,
) => void | Promise<void>;

@Injectable()
export class TripRejectionCooldownService implements OnModuleDestroy {
  private readonly logger = new Logger(TripRejectionCooldownService.name);
  private readonly cooldowns = new Map<string, CooldownEntry>();
  private expireHandler: RejectionCooldownExpiredHandler | null = null;

  private key(driverId: string | number, tripId: TripId): string {
    return `${String(driverId)}:${tripIdKey(tripId)}`;
  }

  setExpireHandler(handler: RejectionCooldownExpiredHandler): void {
    this.expireHandler = handler;
  }

  isHidden(driverId: string | number, tripId: TripId): boolean {
    const entry = this.cooldowns.get(this.key(driverId, tripId));
    if (!entry) {
      return false;
    }

    if (entry.expiresAt <= Date.now()) {
      this.clear(driverId, tripId);
      return false;
    }

    return true;
  }

  recordRejection(
    driverId: string | number,
    tripId: TripId,
    reason?: string,
  ): void {
    const id = String(driverId);
    const mapKey = this.key(id, tripId);

    const existing = this.cooldowns.get(mapKey);
    if (existing) {
      clearTimeout(existing.timerId);
    }

    const expiresAt = Date.now() + REJECTION_COOLDOWN_MS;
    const timerId = setTimeout(() => {
      this.onExpired(id, tripId);
    }, REJECTION_COOLDOWN_MS);

    this.cooldowns.set(mapKey, { expiresAt, timerId, reason });

    this.logger.log(
      `Driver ${id} rejected trip ${tripIdKey(tripId)} — hidden for ${REJECTION_COOLDOWN_MS / 1000}s` +
        (reason ? ` (reason: ${reason})` : ''),
    );
  }

  clear(driverId: string | number, tripId: TripId): void {
    const mapKey = this.key(driverId, tripId);
    const entry = this.cooldowns.get(mapKey);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timerId);
    this.cooldowns.delete(mapKey);
  }

  clearAllForTrip(tripId: TripId): void {
    const suffix = `:${tripIdKey(tripId)}`;
    for (const mapKey of [...this.cooldowns.keys()]) {
      if (mapKey.endsWith(suffix)) {
        const entry = this.cooldowns.get(mapKey);
        if (entry) {
          clearTimeout(entry.timerId);
        }
        this.cooldowns.delete(mapKey);
      }
    }
  }

  private async onExpired(driverId: string, tripId: TripId): Promise<void> {
    this.cooldowns.delete(this.key(driverId, tripId));
    this.logger.log(
      `Rejection cooldown expired for driver ${driverId} trip ${tripIdKey(tripId)}`,
    );

    if (this.expireHandler) {
      await this.expireHandler(driverId, tripId);
    }
  }

  onModuleDestroy(): void {
    for (const entry of this.cooldowns.values()) {
      clearTimeout(entry.timerId);
    }
    this.cooldowns.clear();
  }
}
