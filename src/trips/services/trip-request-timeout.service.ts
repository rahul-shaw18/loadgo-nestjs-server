import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { TRIP_STATUS } from '../../config/app.config';
import { EVENTS } from '../../config/events.constant';
import { DriverQueueService } from './driver-queue.service';
import { OfferManagerService } from './offer-manager.service';
import { TripEventEmitterService } from './trip-event-emitter.service';
import { TripParticipantsService } from './trip-participants.service';
import { ConnectionManagerService } from './connection-manager.service';
import { LocationCacheService } from './location-cache.service';
import { TripRejectionCooldownService } from './trip-rejection-cooldown.service';
import { TripAcceptanceCacheService } from './trip-acceptance-cache.service';
import { BackendApiService } from './backend-api.service';
import { TripId, tripIdKey } from '../utils/trip-id.util';

export const TRIP_REQUEST_TIMEOUT_MESSAGE =
  'No drivers were available for your trip.';

@Injectable()
export class TripRequestTimeoutService {
  private readonly logger = new Logger(TripRequestTimeoutService.name);
  private readonly terminalTrips = new Set<string>();

  constructor(
    private readonly driverQueue: DriverQueueService,
    private readonly offerManager: OfferManagerService,
    private readonly tripEventEmitter: TripEventEmitterService,
    private readonly tripParticipants: TripParticipantsService,
    private readonly connectionManager: ConnectionManagerService,
    private readonly locationCache: LocationCacheService,
    private readonly rejectionCooldown: TripRejectionCooldownService,
    private readonly acceptanceCache: TripAcceptanceCacheService,
    private readonly backendApi: BackendApiService,
  ) {}

  isTerminal(tripId: TripId): boolean {
    return this.terminalTrips.has(tripIdKey(tripId));
  }

  private markTerminal(tripId: TripId): void {
    this.terminalTrips.add(tripIdKey(tripId));
  }

  handleRequestTimeout(
    io: Server,
    tripId: TripId,
    userId?: string | number,
  ): void {
    if (this.isTerminal(tripId)) {
      this.logger.log(
        `[TripTimeout] Trip ${tripId} already terminal — ignoring duplicate status 8`,
      );
      return;
    }

    this.markTerminal(tripId);
    this.logger.log(
      `[TripTimeout] Trip ${tripId} reached timeout (Status ${TRIP_STATUS.REQUEST_TIMEOUT})`,
    );

    const participants = this.tripParticipants.get(tripId);
    const resolvedUserId = userId ?? participants?.userId;

    if (userId) {
      this.tripParticipants.setUser(tripId, userId);
    }

    const queuedDrivers = this.driverQueue.getDriversWithTrip(tripId);
    const driversWithActiveOffer =
      this.offerManager.getDriverIdsWithActiveOfferForTrip(tripId);

    this.logger.log(`[TripTimeout] Removing trip from active offers`);
    this.logger.log(`[TripTimeout] Clearing driver queues`);

    this.offerManager.clearAllOffersForTrip(io, tripId);

    const driversToNotify = new Set([
      ...queuedDrivers,
      ...driversWithActiveOffer,
    ]);

    for (const driverId of driversToNotify) {
      this.tripEventEmitter.emitDirectToDriver(
        io,
        driverId,
        EVENTS.TRIP_REVOKED,
        { tripId },
        'trip-timeout:driver-revoke',
      );
    }

    const timeoutPayload = {
      tripId,
      status: TRIP_STATUS.REQUEST_TIMEOUT,
      message: TRIP_REQUEST_TIMEOUT_MESSAGE,
    };

    if (resolvedUserId) {
      this.logger.log(
        `[TripTimeout] Emitting ${EVENTS.TRIP_REQUEST_TIMEOUT} to user ${resolvedUserId}`,
      );
      this.tripEventEmitter.emitDirectToUser(
        io,
        resolvedUserId,
        EVENTS.TRIP_REQUEST_TIMEOUT,
        timeoutPayload,
        'trip-timeout',
      );
    } else {
      this.logger.warn(
        `[TripTimeout] No userId for trip ${tripId} — ${EVENTS.TRIP_REQUEST_TIMEOUT} not delivered`,
      );
    }

    this.logger.log(`[TripTimeout] Cleaning trip state`);
    this.cleanupTripState(io, tripId);
    this.backendApi.invalidateTripCache(tripId);

    this.logger.log(`[TripTimeout] Complete`);
  }

  private cleanupTripState(io: Server, tripId: TripId): void {
    this.locationCache.clear(tripId);
    this.tripParticipants.clear(tripId);
    this.rejectionCooldown.clearAllForTrip(tripId);
    this.acceptanceCache.clear(tripId);
    this.connectionManager.leaveTripRoom(io, tripId);
  }
}
