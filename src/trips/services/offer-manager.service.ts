import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { SCREEN_TIMER_MS, ROTATION_GAP_MS } from '../../config/app.config';
import { EVENTS } from '../../config/events.constant';
import { DriverQueueService } from './driver-queue.service';
import { ConnectionManagerService } from './connection-manager.service';
import { DriverStateService } from './driver-state.service';
import { TripRejectionCooldownService } from './trip-rejection-cooldown.service';
import { TripId, tripIdsEqual } from '../utils/trip-id.util';

interface ActiveOffer {
  tripId: TripId;
  screenTimerId: NodeJS.Timeout;
}

@Injectable()
export class OfferManagerService {
  private readonly logger = new Logger(OfferManagerService.name);

  private activeOffers: Record<string, ActiveOffer> = {};

  constructor(
    private readonly driverQueue: DriverQueueService,
    private readonly connectionManager: ConnectionManagerService,
    private readonly driverState: DriverStateService,
    private readonly rejectionCooldown: TripRejectionCooldownService,
  ) {}

  private getNextEligibleTrip(driverId: string) {
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

    const now = Date.now();
    const bgTimeLeft = nextTrip.bgExpireAt - now;
    const screenTimeMs = Math.min(SCREEN_TIMER_MS, bgTimeLeft);

    if (screenTimeMs <= 0) {
      this.driverQueue.rotateCurrentTrip(id);
      this.offerNextTrip(io, id);
      return;
    }

    const socketId = this.connectionManager.getDriverSocketId(id);
    if (!socketId) {
      this.logger.debug(`Driver ${id} is offline, skipping offer for now`);
      return;
    }

    const screenTimerId = setTimeout(() => {
      this.onScreenTimeout(io, id);
    }, screenTimeMs);

    this.activeOffers[id] = {
      tripId: nextTrip.tripId,
      screenTimerId,
    };

    this.logger.log(
      `Emitting ${EVENTS.INCOMING_TRIP} to driver ${id} (socket ${socketId}): ${JSON.stringify({ tripId: nextTrip.tripId, screenTimeout: Math.ceil(screenTimeMs / 1000) })}`,
    );
    io.to(socketId).emit(EVENTS.INCOMING_TRIP, {
      tripId: nextTrip.tripId,
      screenTimeout: Math.ceil(screenTimeMs / 1000),
    });

    this.logger.log(
      `Offered trip ${nextTrip.tripId} to driver ${id} ` +
        `(screen: ${Math.ceil(screenTimeMs / 1000)}s, ` +
        `bg left: ${Math.ceil(bgTimeLeft / 1000)}s, ` +
        `queue size: ${this.driverQueue.getQueueSize(id)})`,
    );
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

  restoreQueuedOfferOnRegister(io: Server, driverId: string | number): void {
    const id = String(driverId);
    if (!this.driverState.canReceiveOffers(id)) {
      return;
    }

    if (this.driverQueue.getQueueSize(id) > 0) {
      this.offerNextTrip(io, id);
    }
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
    this.driverQueue.clearDriver(id);
    this.driverState.setOffline(id);
    this.logger.log(`Full cleanup done for driver ${id}`);
  }

  onDriverDisconnect(driverId: string | number) {
    this.clearOffer(driverId);
    this.driverState.setReconnecting(driverId);
    this.logger.log(
      `Driver ${driverId} disconnected — offer cleared, state reconnecting`,
    );
  }

  onDriverDisconnectDuringActiveTrip(driverId: string | number) {
    this.clearOffer(driverId);
    this.logger.log(
      `Driver ${driverId} disconnected during active trip — on_trip state preserved`,
    );
  }
}
