import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { SCREEN_TIMER_MS, ROTATION_GAP_MS } from '../../config/app.config';
import { EVENTS } from '../../config/events.constant';
import { DriverQueueService } from './driver-queue.service';
import { ConnectionManagerService } from './connection-manager.service';

interface ActiveOffer {
  tripId: number;
  screenTimerId: NodeJS.Timeout;
}

@Injectable()
export class OfferManagerService {
  private readonly logger = new Logger(OfferManagerService.name);

  // State
  private activeOffers: Record<string, ActiveOffer> = {};

  constructor(
    private readonly driverQueue: DriverQueueService,
    private readonly connectionManager: ConnectionManagerService,
  ) {}

  offerNextTrip(io: Server, driverId: string | number) {
    const id = String(driverId);

    if (this.activeOffers[id]) {
      this.logger.debug(`Driver ${id} already has an active offer, skipping`);
      return;
    }

    const nextTrip = this.driverQueue.getNextTrip(id);
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

    this.logger.log(`Emitting ${EVENTS.INCOMING_TRIP} to driver ${id} (socket ${socketId}): ${JSON.stringify({ tripId: nextTrip.tripId, screenTimeout: Math.ceil(screenTimeMs / 1000) })}`);
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

    this.logger.log(
      `Screen timer expired for driver ${id} on trip ${offer.tripId}`,
    );

    const socketId = this.connectionManager.getDriverSocketId(id);
    if (socketId) {
      this.logger.log(`Emitting ${EVENTS.INCOMING_TRIP_EXPIRED} to driver ${id} (socket ${socketId}): ${JSON.stringify({ tripId: offer.tripId })}`);
      io.to(socketId).emit(EVENTS.INCOMING_TRIP_EXPIRED, {
        tripId: offer.tripId,
      });
    }

    delete this.activeOffers[id];
    this.driverQueue.rotateCurrentTrip(id);

    setTimeout(() => {
      this.offerNextTrip(io, id);
    }, ROTATION_GAP_MS);
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

  clearAllOffersForTrip(io: Server, tripId: number) {
    const affectedDrivers: string[] = [];

    for (const driverId of Object.keys(this.activeOffers)) {
      if (this.activeOffers[driverId].tripId === tripId) {
        this.clearOffer(driverId);
        affectedDrivers.push(driverId);
      }
    }

    if (affectedDrivers.length > 0) {
      this.logger.log(
        `Cleared offers for trip ${tripId} from ${affectedDrivers.length} driver(s), ` +
          `will offer next trip after ${ROTATION_GAP_MS}ms gap`,
      );

      setTimeout(() => {
        affectedDrivers.forEach((id) => {
          this.offerNextTrip(io, id);
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
    tripId: number,
  ): { valid: boolean; tripId: number | null } {
    const id = String(driverId);
    const offer = this.activeOffers[id];

    if (!offer || Number(offer.tripId) !== Number(tripId)) {
      this.logger.warn(
        `Driver ${id} tried to accept trip ${tripId} ` +
          `but current offer is ${offer ? offer.tripId : 'none'}`,
      );
      return { valid: false, tripId: null };
    }

    this.logger.log(`Driver ${id} accepted trip ${tripId}`);
    this.clearOffer(id);

    return { valid: true, tripId };
  }

  cleanupDriver(driverId: string | number) {
    const id = String(driverId);
    this.clearOffer(id);
    this.driverQueue.clearDriver(id);
    this.logger.log(`Full cleanup done for driver ${id}`);
  }
}
