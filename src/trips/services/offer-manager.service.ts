import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import {
  SCREEN_TIMER_MS,
  ROTATION_GAP_MS,
  TRIP_STATUS,
} from '../../config/app.config';
import { EVENTS } from '../../config/events.constant';
import { DriverQueueService, QueueEntry } from './driver-queue.service';
import { ConnectionManagerService } from './connection-manager.service';
import { DriverStateService } from './driver-state.service';
import { TripRejectionCooldownService } from './trip-rejection-cooldown.service';
import { BackendApiService } from './backend-api.service';
import { TripEventEmitterService } from './trip-event-emitter.service';
import { TripId, tripIdKey, tripIdsEqual } from '../utils/trip-id.util';

interface ActiveOffer {
  tripId: TripId;
  screenTimerId: NodeJS.Timeout;
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
    private readonly tripEventEmitter: TripEventEmitterService,
  ) {}

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
      void this.onScreenTimeout(io, driverId);
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

    this.driverQueue.logQueueState(
      driverId,
      `Active offer → Trip ${queueEntry.tripId} (screen: ${Math.ceil(effectiveScreenMs / 1000)}s)`,
    );

    return true;
  }

  /**
   * Walks the driver's queue sequentially, skipping invalid entries,
   * and presents exactly one INCOMING_TRIP when a valid candidate is found.
   */
  async advanceToNextOffer(
    io: Server,
    driverId: string | number,
    trigger: string,
  ): Promise<void> {
    const id = String(driverId);

    if (!this.driverState.canReceiveOffers(id)) {
      this.logger.debug(
        `[DriverQueue] Driver ${id} — ${trigger}: cannot receive offers`,
      );
      return;
    }

    if (this.activeOffers[id]) {
      this.logger.debug(
        `[DriverQueue] Driver ${id} — ${trigger}: active offer already showing`,
      );
      return;
    }

    const maxAttempts = this.driverQueue.getQueueSize(id) + 1;
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts += 1;

      const nextTrip = this.driverQueue.getNextTrip(id);
      if (!nextTrip) {
        this.driverQueue.logQueueState(id, `${trigger}: queue empty`);
        return;
      }

      if (nextTrip.bgExpireAt <= Date.now()) {
        this.driverQueue.removeTripFromDriver(id, nextTrip.tripId);
        this.logger.log(
          `[DriverQueue] Driver ${id}\nTrip ${nextTrip.tripId} skipped (background timer expired)\n\nQueue:\n${this.driverQueue.getQueueTripIds(id).join('\n') || '(empty)'}`,
        );
        continue;
      }

      if (this.rejectionCooldown.isHidden(id, nextTrip.tripId)) {
        this.driverQueue.deferFrontTrip(id);
        continue;
      }

      const validation = await this.validateTripForOffer(nextTrip.tripId);
      if (!validation.ok) {
        this.driverQueue.removeTripFromDriver(id, nextTrip.tripId);
        const nextIds = this.driverQueue.getQueueTripIds(id);
        this.logger.log(
          `[DriverQueue] Driver ${id}\nTrip ${nextTrip.tripId} ${validation.reason}\n\nRemoving...\n\nNext Trip:\n${nextIds[0] ?? '(none)'}`,
        );
        continue;
      }

      const socketId = this.connectionManager.getDriverSocketId(id);
      if (!socketId) {
        this.logger.debug(
          `[DriverQueue] Driver ${id} — ${trigger}: offline, queue preserved`,
        );
        return;
      }

      if (this.emitIncomingTrip(io, id, nextTrip, { socketId })) {
        return;
      }

      this.driverQueue.removeTripFromDriver(id, nextTrip.tripId);
    }

    this.driverQueue.logQueueState(id, `${trigger}: no valid offers remaining`);
  }

  offerNextTrip(io: Server, driverId: string | number): void {
    void this.advanceToNextOffer(io, driverId, 'offer-next');
  }

  scheduleNextOffer(io: Server, driverId: string | number, trigger: string): void {
    setTimeout(() => {
      void this.advanceToNextOffer(io, driverId, trigger);
    }, ROTATION_GAP_MS);
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

    const queueSize = this.driverQueue.getQueueSize(id);
    if (queueSize === 0) {
      this.logger.log(`[driver-recovery] No queued offers`);
      this.logger.log(`[driver-recovery] Recovery complete`);
      return;
    }

    this.logger.log(
      `[driver-recovery] Found ${queueSize} queued offer(s)`,
    );
    this.driverQueue.logQueueState(id, 'Reconnect — restoring queue');

    const nextTrip = this.driverQueue.getNextTrip(id);
    if (
      nextTrip &&
      this.hasOfferSentOnSocket(socketId, nextTrip.tripId) &&
      this.activeOffers[id]
    ) {
      this.logger.log(
        `[driver-recovery] Trip ${nextTrip.tripId} already active on this connection — skipping`,
      );
      this.logger.log(`[driver-recovery] Recovery complete`);
      return;
    }

    await this.advanceToNextOffer(io, id, 'reconnect-recovery');
    this.logger.log(`[driver-recovery] Recovery complete`);
  }

  private async onScreenTimeout(io: Server, driverId: string | number) {
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
      io.to(socketId).emit(EVENTS.INCOMING_TRIP_EXPIRED, {
        tripId: offer.tripId,
      });
    }

    this.tripEventEmitter.emitToTripRoom(
      io,
      offer.tripId,
      EVENTS.TRIP_REQUEST_TIMEOUT,
      { tripId: offer.tripId, driverId: id },
      'offer-screen-timeout',
      { driverId: id },
    );

    delete this.activeOffers[id];
    this.driverQueue.removeFrontTrip(id);

    if (this.driverState.canReceiveOffers(id)) {
      this.scheduleNextOffer(io, id, 'screen-timeout');
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

  getDriverIdsWithActiveOfferForTrip(tripId: TripId): string[] {
    return Object.keys(this.activeOffers).filter((driverId) =>
      tripIdsEqual(this.activeOffers[driverId].tripId, tripId),
    );
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

    const queuedDrivers = this.driverQueue.removeTripFromAllDrivers(tripId);

    const driversToAdvance = new Set([...affectedDrivers, ...queuedDrivers]);

    if (driversToAdvance.size > 0) {
      this.logger.log(
        `Cleared trip ${tripId} from ${driversToAdvance.size} driver(s) — advancing queues`,
      );

      driversToAdvance.forEach((id) => {
        if (
          assigneeDriverId !== undefined &&
          String(id) === String(assigneeDriverId)
        ) {
          return;
        }
        if (this.driverState.canReceiveOffers(id)) {
          this.scheduleNextOffer(io, id, 'trip-taken-by-other');
        }
      });
    }
  }

  handleReject(io: Server, driverId: string | number, tripId?: TripId) {
    const id = String(driverId);

    if (!this.driverState.canReceiveOffers(id)) {
      this.logger.log(
        `Ignoring reject for driver ${id} — driver is past offer stage`,
      );
      this.clearOffer(id);
      return;
    }

    const offer = this.activeOffers[id];
    const rejectedTripId = tripId ?? offer?.tripId;

    if (!rejectedTripId) {
      return;
    }

    this.clearOffer(id);

    if (this.driverQueue.hasTripInQueue(id, rejectedTripId)) {
      this.driverQueue.removeTripFromDriver(id, rejectedTripId);
    }

    const nextTrip = this.driverQueue.getNextTrip(id);
    this.logger.log(
      `[DriverQueue] Driver ${id}\nRejected Trip ${rejectedTripId}\n\nNext Trip:\n${nextTrip?.tripId ?? '(none)'}`,
    );

    this.scheduleNextOffer(io, id, 'reject');
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
    this.driverQueue.clearDriverQueue(
      id,
      `Accepted Trip ${tripId}\n\nClearing remaining queue`,
    );

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
    const id = String(driverId);
    this.clearOffer(id);
    this.driverState.setReconnecting(id);
    this.logger.log(
      `Driver ${id} disconnected — offer timer cleared, queue preserved (size: ${this.driverQueue.getQueueSize(id)})`,
    );
  }

  onDriverDisconnectDuringActiveTrip(driverId: string | number) {
    this.clearOffer(driverId);
    this.logger.log(
      `Driver ${driverId} disconnected during active trip — on_trip state preserved`,
    );
  }
}
