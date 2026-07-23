import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { rejectionCooldownMsForCount } from '../../config/app.config';
import { TripId, tripIdKey } from '../utils/trip-id.util';

interface CooldownEntry {
  /** Number of times this driver has rejected this trip (persists after timer expires). */
  rejectionCount: number;
  expiresAt: number;
  timerId: NodeJS.Timeout | null;
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

  private parseKey(mapKey: string): { driverId: string; tripId: string } | null {
    const idx = mapKey.indexOf(':');
    if (idx <= 0) {
      return null;
    }
    return {
      driverId: mapKey.slice(0, idx),
      tripId: mapKey.slice(idx + 1),
    };
  }

  setExpireHandler(handler: RejectionCooldownExpiredHandler): void {
    this.expireHandler = handler;
  }

  getRejectionCount(driverId: string | number, tripId: TripId): number {
    return this.cooldowns.get(this.key(driverId, tripId))?.rejectionCount ?? 0;
  }

  isHidden(driverId: string | number, tripId: TripId): boolean {
    const entry = this.cooldowns.get(this.key(driverId, tripId));
    if (!entry || entry.timerId === null) {
      return false;
    }

    if (entry.expiresAt <= Date.now()) {
      this.markCooldownElapsed(String(driverId), tripId, entry);
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
    if (existing?.timerId) {
      clearTimeout(existing.timerId);
    }

    const rejectionCount = (existing?.rejectionCount ?? 0) + 1;
    const cooldownMs = rejectionCooldownMsForCount(rejectionCount);
    const expiresAt = Date.now() + cooldownMs;
    const timerId = setTimeout(() => {
      this.onExpired(id, tripId);
    }, cooldownMs);

    this.cooldowns.set(mapKey, {
      rejectionCount,
      expiresAt,
      timerId,
      reason,
    });

    this.logger.log(
      `[RejectionCooldown]\n\nDriver:\n${id}\n\nTrip:\n${tripIdKey(tripId)}\n\nRejection Count:\n${rejectionCount}\n\nCooldown:\n${cooldownMs / 1000} seconds` +
        (reason ? `\n\nReason:\n${reason}` : ''),
    );
  }

  clear(driverId: string | number, tripId: TripId): void {
    const mapKey = this.key(driverId, tripId);
    const entry = this.cooldowns.get(mapKey);
    if (!entry) {
      return;
    }

    if (entry.timerId) {
      clearTimeout(entry.timerId);
    }
    this.cooldowns.delete(mapKey);
  }

  clearAllForTrip(tripId: TripId): void {
    const suffix = `:${tripIdKey(tripId)}`;
    const clearedDrivers: string[] = [];

    for (const mapKey of [...this.cooldowns.keys()]) {
      if (!mapKey.endsWith(suffix)) {
        continue;
      }

      const entry = this.cooldowns.get(mapKey);
      if (entry?.timerId) {
        clearTimeout(entry.timerId);
      }
      this.cooldowns.delete(mapKey);

      const parsed = this.parseKey(mapKey);
      if (parsed) {
        clearedDrivers.push(parsed.driverId);
      }
    }

    if (clearedDrivers.length > 0) {
      this.logger.log(
        `[RejectionCooldown]\n\nTrip ${tripIdKey(tripId)} terminated\n\nClearing rejection history for Driver(s): ${clearedDrivers.join(', ')}`,
      );
    }
  }

  private markCooldownElapsed(
    driverId: string,
    tripId: TripId,
    entry: CooldownEntry,
  ): void {
    if (entry.timerId) {
      clearTimeout(entry.timerId);
    }
    // Keep rejectionCount so the next reject escalates; clear active hide window.
    this.cooldowns.set(this.key(driverId, tripId), {
      rejectionCount: entry.rejectionCount,
      expiresAt: 0,
      timerId: null,
      reason: entry.reason,
    });
  }

  private async onExpired(driverId: string, tripId: TripId): Promise<void> {
    const mapKey = this.key(driverId, tripId);
    const entry = this.cooldowns.get(mapKey);
    if (!entry) {
      return;
    }

    this.markCooldownElapsed(driverId, tripId, entry);

    this.logger.log(
      `[RejectionCooldown]\n\nDriver:\n${driverId}\n\nTrip:\n${tripIdKey(tripId)}\n\nCooldown expired (rejection count preserved: ${entry.rejectionCount})`,
    );

    if (this.expireHandler) {
      await this.expireHandler(driverId, tripId);
    }
  }

  onModuleDestroy(): void {
    for (const entry of this.cooldowns.values()) {
      if (entry.timerId) {
        clearTimeout(entry.timerId);
      }
    }
    this.cooldowns.clear();
  }
}
