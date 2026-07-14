import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import {
  SCREEN_TIMER_MS,
  ROTATION_GAP_MS,
  TRIP_STATUS,
} from '../../config/app.config';
import { EVENTS } from '../../config/events.constant';
import { DriverQueueService } from './driver-queue.service';
import { ConnectionManagerService } from './connection-manager.service';
import { DriverStateService } from './driver-state.service';
import { TripRejectionCooldownService } from './trip-rejection-cooldown.service';
import { BackendApiService } from './backend-api.service';
import { TripId, tripIdKey, tripIdsEqual } from '../utils/trip-id.util';

interface ActiveOffer {
  tripId: TripId;
  screenTimerId: NodeJS.Timeout;
}

interface QueueEntry {
  tripId: TripId;
  addedAt: number;
  bgExpireAt: number;
}

const OFFER_INELIGIBLE_REASONS: Record<number, string> = {
  [TRIP_STATUS.ACCEPTED]: 'already accepted',
  3: 'revoked',
  [TRIP_STATUS.STARTED]: 'already started',
  [TRIP_STATUS.COMPLETED]: 'completed',
  [TRIP_STATUS.CANCELLED_BY_USER]: 'cancelled by user',
  [TRIP_STATUS.CANCELLED_BY_DRIVER]: 'cancelled by driver',
  8: 'expired',
};

@Injectable()
export class OfferManagerService {
  private readonly logger = new Logger(OfferManagerService.name);

  private activeOffers: Record<string, ActiveOffer> = {};
  private readonly offersSentOnSocket = new Map<string, Set<string>>();

  constructor(
    private readonly driverQueue: DriverQueueService,
    private readonly connectionManager: ConnectionManagerService,
    private readonly driverState: DriverStateService,
    private readonly rejectionCooldown: TripRejectionCooldownService,
    private readonly backendApi: BackendApiService,
  ) {}

  private getNextEligibleTrip(driverId: string): QueueEntry | null {
    const id = String(driverId);
    let attempts = 0;
    const maxAttempts = this.driverQueue.getQueueSize(id) + 1;

    while (attempts < maxAttempts) {
      attempts += 1;
      const nextTrip = this.driverQueue.getNextTrip(id);
      if (!nextTrip) {
        return null;
      }

      if (!this.rejectionCooldown.isHidden(id, nextTrip.tripId)) {
        return nextTrip;
      }

      this.logger.debug(
        `Skipping trip ${nextTrip.tripId} for driver ${id} — rejection cooldown active`,
      );
      this.driverQueue.rotateCurrentTrip(id);
    }

    return null;
  }

  private describeIneligibleTrip(status: number | null): string {
    if (status === null) {
      return 'trip not found';
    }
    return OFFER_INELIGIBLE_REASONS[status] ?? `status ${status}`;
  }

  private async validateTripForOffer(
    tripId: TripId,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const status = await this.backendApi.fetchTripStatus(tripId);
    if (status === TRIP_STATUS.REQUESTED) {
      return { ok: true };
    }
    return { ok: false, reason: this.describeIneligibleTrip(status) };
  }

  private markOfferSentOnSocket(socketId: string, tripId: TripId): void {
    const key = tripIdKey(tripId);
    const sent = this.offersSentOnSocket.get(socketId) ?? new Set<string>();
    sent.add(key);
    this.offersSentOnSocket.set(socketId, sent);
  }

  hasOfferSentOnSocket(socketId: string, tripId: TripId): boolean {
    return this.offersSentOnSocket.get(socketId)?.has(tripIdKey(tripId)) ?? false;
  }

  clearSocketOfferTracking(socketId: string): void {
    this.offersSentOnSocket.delete(socketId);
  }

  private emitIncomingTrip(
    io: Server,
    driverId: string,
    queueEntry: QueueEntry,
    options?: { socketId?: string },
  ): boolean {
    const now = Date.now();
    const bgTimeLeft = queueEntry.bgExpireAt - now;

    if (bgTimeLeft <= 0) {
      this.driverQueue.rotateCurrentTrip(driverId);
      return false;
    }

    const socketId =
      options?.socketId ?? this.connectionManager.getDriverSocketId(driverId);
    if (!socketId) {
      this.logger.debug(`Driver ${driverId} is offline, skipping offer for now`);
      return false;
    }

    const effectiveScreenMs = Math.min(SCREEN_TIMER_MS, bgTimeLeft);

    this.clearOffer(driverId);

    const screenTimerId = setTimeout(() => {
      this.onScreenTimeout(io, driverId);
    }, effectiveScreenMs);

    this.activeOffers[driverId] = {
      tripId: queueEntry.tripId,
      screenTimerId,
    };

    this.markOfferSentOnSocket(socketId, queueEntry.tripId);

    const payload = {
      tripId: queueEntry.tripId,
      screenTimeout: Math.ceil(effectiveScreenMs / 1000),
    };

    this.logger.log(
      `Emitting ${EVENTS.INCOMING_TRIP} to driver ${driverId} (socket ${socketId}): ${JSON.stringify(payload)}`,
    );
    io.to(socketId).emit(EVENTS.INCOMING_TRIP, payload);

    this.logger.log(
      `Offered trip ${queueEntry.tripId} to driver ${driverId} ` +
        `(screen: ${Math.ceil(effectiveScreenMs / 1000)}s, ` +
        `bg left: ${Math.ceil(bgTimeLeft / 1000)}s, ` +
        `queue size: ${this.driverQueue.getQueueSize(driverId)})`,
    );

    return true;
  }

  offerNextTrip(io: Server, driverId: string | number) {
    const id = String(driverId);

    if (!this.driverState.canReceiveOffers(id)) {
      this.logger.debug(
        `Driver ${id} is on an active trip — skipping new offers`,
      );
      return;
    }

    if (this.activeOffers[id]) {
      this.logger.debug(`Driver ${id} already has an active offer, skipping`);
      return;
    }

    const nextTrip = this.getNextEligibleTrip(id);
    if (!nextTrip) {
      this.logger.debug(`No trips in queue for driver ${id}`);
      return;
    }

    this.emitIncomingTrip(io, id, nextTrip);
  }

  async recoverPendingOffersOnRegister(
    io: Server,
    driverId: string | number,
    socketId: string,
  ): Promise<void> {
    const id = String(driverId);
    this.logger.log(`[driver-recovery] Driver ${id} connected`);

    if (!this.driverState.canReceiveOffers(id)) {
      this.logger.log(
        `[driver-recovery] Driver ${id} cannot receive offers — skipping recovery`,
      );
      return;
    }

    this.logger.log(`[driver-recovery] Checking pending offers...`);
    const queue = this.driverQueue.getQueue(id);

    if (queue.length === 0) {
      this.logger.log(`[driver-recovery] No queued offers`);
      this.logger.log(`[driver-recovery] Recovery complete`);
      return;
    }

    this.logger.log(
      `[driver-recovery] Found ${queue.length} queued offer(s)`,
    );

    for (const entry of [...queue]) {
      if (entry.bgExpireAt <= Date.now()) {
        this.driverQueue.removeTripFromDriver(id, entry.tripId);
        this.logger.log(
          `[driver-recovery] Trip ${entry.tripId} skipped (background timer expired)`,
        );
        continue;
      }

      if (!this.driverQueue.hasTripInQueue(id, entry.tripId)) {
        continue;
      }

      const validation = await this.validateTripForOffer(entry.tripId);
      if (!validation.ok) {
        this.driverQueue.removeTripFromDriver(id, entry.tripId);
        this.logger.log(
          `[driver-recovery] Trip ${entry.tripId} skipped (${validation.reason})`,
        );
        continue;
      }

      const bgLeftSec = Math.ceil((entry.bgExpireAt - Date.now()) / 1000);
      this.logger.log(
        `[driver-recovery] Trip ${entry.tripId} still active (${bgLeftSec}s background remaining)`,
      );
    }

    if (this.driverQueue.getQueueSize(id) === 0) {
      this.logger.log(`[driver-recovery] Recovery complete`);
      return;
    }

    const nextTrip = this.getNextEligibleTrip(id);
    if (!nextTrip) {
      this.logger.log(`[driver-recovery] Recovery complete`);
      return;
    }

    if (this.hasOfferSentOnSocket(socketId, nextTrip.tripId)) {
      this.logger.log(
        `[driver-recovery] Trip ${nextTrip.tripId} already sent on this connection — skipping`,
      );
      this.logger.log(`[driver-recovery] Recovery complete`);
      return;
    }

    const validation = await this.validateTripForOffer(nextTrip.tripId);
    if (!validation.ok) {
      this.driverQueue.removeTripFromDriver(id, nextTrip.tripId);
      this.logger.log(
        `[driver-recovery] Trip ${nextTrip.tripId} skipped (${validation.reason})`,
      );
      this.logger.log(`[driver-recovery] Recovery complete`);
      return;
    }

    const emitted = this.emitIncomingTrip(io, id, nextTrip, { socketId });

    if (emitted) {
      this.logger.log(
        `[driver-recovery] Re-emitting INCOMING_TRIP to driver ${id} for trip ${nextTrip.tripId}`,
      );
    }

    this.logger.log(`[driver-recovery] Recovery complete`);
  }

  private onScreenTimeout(io: Server, driverId: string | number) {
    const id = String(driverId);
    const offer = this.activeOffers[id];
    if (!offer) return;

    if (this.driverState.isAssigneeForTrip(id, offer.tripId)) {
      this.logger.log(
        `Skipping ${EVENTS.INCOMING_TRIP_EXPIRED} — driver ${id} is assignee for trip ${offer.tripId}`,
      );
      delete this.activeOffers[id];
      return;
    }

    this.logger.log(
      `Screen timer expired for driver ${id} on trip ${offer.tripId}`,
    );

    const socketId = this.connectionManager.getDriverSocketId(id);
    if (socketId && this.driverState.canReceiveOffers(id)) {
      this.logger.log(
        `Emitting ${EVENTS.INCOMING_TRIP_EXPIRED} to driver ${id} (socket ${socketId}): ${JSON.stringify({ tripId: offer.tripId })}`,
      );
      io.to(socketId).emit(EVENTS.INCOMING_TRIP_EXPIRED, {
        tripId: offer.tripId,
      });
    }

    delete this.activeOffers[id];
    this.driverQueue.rotateCurrentTrip(id);

    if (this.driverState.canReceiveOffers(id)) {
      setTimeout(() => {
        this.offerNextTrip(io, id);
      }, ROTATION_GAP_MS);
    }
  }

  clearOffer(driverId: string | number) {
    const id = String(driverId);
    const offer = this.activeOffers[id];
    if (!offer) return;

    clearTimeout(offer.screenTimerId);
    delete this.activeOffers[id];
    this.logger.debug(`Offer cleared for driver ${id}`);
  }

  getOffer(driverId: string | number): ActiveOffer | null {
    return this.activeOffers[String(driverId)] || null;
  }

  hasOffer(driverId: string | number): boolean {
    return !!this.activeOffers[String(driverId)];
  }

  clearAllOffersForTrip(
    io: Server,
    tripId: TripId,
    assigneeDriverId?: string | number,
  ) {
    const affectedDrivers: string[] = [];

    for (const driverId of Object.keys(this.activeOffers)) {
      if (!tripIdsEqual(this.activeOffers[driverId].tripId, tripId)) {
        continue;
      }

      if (
        assigneeDriverId !== undefined &&
        String(driverId) === String(assigneeDriverId)
      ) {
        this.clearOffer(driverId);
        continue;
      }

      this.clearOffer(driverId);
      affectedDrivers.push(driverId);
    }

    this.driverQueue.removeTripFromAllDrivers(tripId);

    if (affectedDrivers.length > 0) {
      this.logger.log(
        `Cleared offers for trip ${tripId} from ${affectedDrivers.length} driver(s)`,
      );

      setTimeout(() => {
        affectedDrivers.forEach((id) => {
          if (this.driverState.canReceiveOffers(id)) {
            this.offerNextTrip(io, id);
          }
        });
      }, ROTATION_GAP_MS);
    }
  }

  handleReject(io: Server, driverId: string | number) {
    const id = String(driverId);

    if (!this.driverState.canReceiveOffers(id)) {
      this.logger.log(
        `Ignoring reject for driver ${id} — driver is past offer stage`,
      );
      this.clearOffer(id);
      return;
    }

    const offer = this.activeOffers[id];
    if (!offer) return;

    this.logger.log(`Driver ${id} rejected trip ${offer.tripId}`);
    this.clearOffer(id);
    this.driverQueue.rotateCurrentTrip(id);

    setTimeout(() => {
      this.offerNextTrip(io, id);
    }, ROTATION_GAP_MS);
  }

  handleAccept(
    driverId: string | number,
    tripId: TripId,
  ): { valid: boolean; tripId: TripId | null } {
    const id = String(driverId);
    const offer = this.activeOffers[id];
    const activeOfferValid =
      !!offer && tripIdsEqual(offer.tripId, tripId);
    const inQueue = this.driverQueue.hasTripInQueue(id, tripId);

    if (!activeOfferValid && !inQueue) {
      this.logger.warn(
        `Driver ${id} tried to accept trip ${tripId} — not in active offer or queue`,
      );
      return { valid: false, tripId: null };
    }

    this.logger.log(`Driver ${id} accepted trip ${tripId}`);
    this.clearOffer(id);

    return { valid: true, tripId };
  }

  cleanupDriver(driverId: string | number) {
    const id = String(driverId);
    if (!this.driverState.isReconnecting(id)) {
      this.logger.debug(
        `Skipping grace cleanup for driver ${id} — no longer reconnecting`,
      );
      return;
    }

    this.clearOffer(id);
    this.driverState.setOffline(id);
    this.logger.log(
      `Driver ${id} marked offline (queue preserved: ${this.driverQueue.getQueueSize(id)} trip(s))`,
    );
  }

  onDriverDisconnect(driverId: string | number) {
    this.clearOffer(driverId);
    this.driverState.setReconnecting(driverId);
    this.logger.log(
      `Driver ${driverId} disconnected — offer timer cleared, queue preserved (size: ${this.driverQueue.getQueueSize(driverId)})`,
    );
  }

  onDriverDisconnectDuringActiveTrip(driverId: string | number) {
    this.clearOffer(driverId);
    this.logger.log(
      `Driver ${driverId} disconnected during active trip — on_trip state preserved`,
    );
  }
}
