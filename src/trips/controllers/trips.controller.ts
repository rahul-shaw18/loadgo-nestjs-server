import {
  Controller,
  Post,
  Body,
  Logger,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { DriverQueueService } from '../services/driver-queue.service';
import { OfferManagerService } from '../services/offer-manager.service';
import { ConnectionManagerService } from '../services/connection-manager.service';
import { LocationCacheService } from '../services/location-cache.service';
import { TripParticipantsService } from '../services/trip-participants.service';
import { TripEventEmitterService } from '../services/trip-event-emitter.service';
import { DriverStateService } from '../services/driver-state.service';
import { TripRejectionCooldownService } from '../services/trip-rejection-cooldown.service';
import { NotifyNewTripDto, TripStatusUpdateDto } from '../dto/trip.dto';
import { TripId } from '../utils/trip-id.util';
import { EVENTS } from '../../config/events.constant';
import { TripsGateway } from '../gateways/trips.gateway';

const STATUS = {
  REQUESTED: 1,
  ACCEPTED: 2,
  REVOKED: 3,
  STARTED: 4,
  COMPLETED: 5,
  CANCELLED_BY_USER: 6,
  CANCELLED_BY_DRIVER: 7,
  REQUEST_TIMEOUT: 8,
};

const STATUS_LABELS: Record<number, string> = {
  [STATUS.REQUESTED]: 'REQUESTED',
  [STATUS.ACCEPTED]: 'ACCEPTED',
  [STATUS.REVOKED]: 'REVOKED',
  [STATUS.STARTED]: 'STARTED',
  [STATUS.COMPLETED]: 'COMPLETED',
  [STATUS.CANCELLED_BY_USER]: 'CANCELLED_BY_USER',
  [STATUS.CANCELLED_BY_DRIVER]: 'CANCELLED_BY_DRIVER',
  [STATUS.REQUEST_TIMEOUT]: 'REQUEST_TIMEOUT',
};

@ApiTags('Trips')
@Controller()
export class TripsController {
  private readonly logger = new Logger(TripsController.name);

  constructor(
    private readonly driverQueue: DriverQueueService,
    private readonly offerManager: OfferManagerService,
    private readonly connectionManager: ConnectionManagerService,
    private readonly locationCache: LocationCacheService,
    private readonly tripParticipants: TripParticipantsService,
    private readonly tripEventEmitter: TripEventEmitterService,
    private readonly driverState: DriverStateService,
    private readonly rejectionCooldown: TripRejectionCooldownService,
    private readonly tripsGateway: TripsGateway,
  ) {}

  private clearTripTrackingState(tripId: TripId) {
    this.locationCache.clear(tripId);
    this.tripParticipants.clear(tripId);
    this.rejectionCooldown.clearAllForTrip(tripId);
    this.logger.log(`Cleared tracking state for trip ${tripId}`);
  }

  @Post('notify-new-trip')
  @ApiOperation({
    summary: 'Notify drivers about a new trip',
    description:
      'Called by the main backend when a new trip is created. ' +
      "Adds the trip to each eligible driver's queue and, if the driver has no active offer, " +
      'immediately emits an INCOMING_TRIP socket event with a 30-second screen timer.',
  })
  @ApiBody({ type: NotifyNewTripDto })
  @ApiResponse({
    status: 200,
    description: 'Trip queued successfully',
    schema: { example: { ok: true } },
  })
  notifyNewTrip(@Body() payload: NotifyNewTripDto, @Res() res: Response) {
    this.logger.log(
      `[notify-new-trip] Received payload: ${JSON.stringify(payload)}`,
    );
    const { tripId, drivers, userId } = payload;
    const io = this.tripsGateway.server;

    if (userId) {
      this.tripParticipants.setUser(tripId, userId);
      this.logger.log(
        `[notify-new-trip] Registered user ${userId} as participant for trip ${tripId}`,
      );
    }

    if (userId && io) {
      this.connectionManager.joinUserToTripRoom(io, userId, tripId);
      this.logger.log(
        `[notify-new-trip] ${this.tripEventEmitter.getRoomDebugInfo(io, tripId)}`,
      );
    }

    this.logger.log(
      `[notify-new-trip] Trip ${tripId} → notifying ${drivers.length} driver(s): [${drivers.join(', ')}]`,
    );

    if (!io) {
      this.logger.warn(
        `[notify-new-trip] Socket.IO server not ready for trip ${tripId}. Drivers will catch up on login.`,
      );
      return res.json({ ok: true });
    }

    drivers.forEach((driverId) => {
      if (!this.driverState.canReceiveOffers(driverId)) {
        this.logger.log(
          `[notify-new-trip] Skipping driver ${driverId} — on active trip`,
        );
        return;
      }

      if (this.rejectionCooldown.isHidden(driverId, tripId)) {
        this.logger.log(
          `[notify-new-trip] Skipping driver ${driverId} — trip ${tripId} in rejection cooldown`,
        );
        return;
      }

      const added = this.driverQueue.addTripToDriver(driverId, tripId);

      if (added && !this.offerManager.hasOffer(driverId)) {
        this.offerManager.offerNextTrip(io, driverId);
      }
    });

    return res.json({ ok: true });
  }

  @Post('trip-status-update')
  @ApiOperation({
    summary: 'Update trip status and emit socket events',
    description:
      'Called by the main backend to transition a trip through its lifecycle. ' +
      'Status codes: 2=ACCEPTED (joins rooms, emits TRIP_ACCEPTED + TRIP_ACCEPTED_BY_OTHER_DRIVER, cleans queues), ' +
      '3=REVOKED (cleans queues, emits TRIP_REVOKED), ' +
      '4=STARTED (emits TRIP_STARTED to room), ' +
      '5=COMPLETED (emits TRIP_COMPLETED to room), ' +
      '6=CANCELLED_BY_USER (cleans queues, emits TRIP_CANCELLED_BY_USER), ' +
      '7=CANCELLED_BY_DRIVER (emits TRIP_CANCELLED_BY_DRIVER), ' +
      '8=REQUEST_TIMEOUT (cleans queues, emits TRIP_REVOKED).',
  })
  @ApiBody({ type: TripStatusUpdateDto })
  @ApiResponse({
    status: 200,
    description: 'Status updated successfully',
    schema: { example: { ok: true } },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid status code',
    schema: { example: { ok: false, message: 'Invalid status code: 99' } },
  })
  tripStatusUpdate(@Body() payload: TripStatusUpdateDto) {
    this.logger.log(
      `[trip-status-update] Received payload: ${JSON.stringify(payload)}`,
    );
    try {
      const { tripId, status, driverId, userId } = payload;
      const io = this.tripsGateway.server;
      const statusCode = Number(status);
      const statusLabel = STATUS_LABELS[statusCode] ?? `UNKNOWN(${statusCode})`;

      this.logger.log(
        `[trip-status-update] Processing ${statusLabel} for trip ${tripId} (driverId=${driverId ?? 'n/a'}, userId=${userId ?? 'n/a'})`,
      );

      if (!io) {
        this.logger.error(
          '[trip-status-update] Socket.IO server is not initialized in TripsGateway',
        );
        return { ok: false, message: 'Socket server not ready' };
      }

      if (driverId) {
        this.tripParticipants.setDriver(tripId, driverId);
      }
      if (userId) {
        this.tripParticipants.setUser(tripId, userId);
      }

      switch (statusCode) {
        case STATUS.ACCEPTED: {
          if (driverId) {
            this.driverState.setOnTrip(driverId, tripId);
          }
          this.rejectionCooldown.clearAllForTrip(tripId);
          const acceptPayload = { tripId, driverId };
          this.tripEventEmitter.emitToTripRoom(
            io,
            tripId,
            EVENTS.TRIP_ACCEPTED,
            acceptPayload,
            'trip-status-update:ACCEPTED',
            { driverId, userId },
          );
          if (driverId) {
            this.tripEventEmitter.emitAcceptedByOtherDrivers(
              io,
              tripId,
              driverId,
              'trip-status-update:ACCEPTED',
            );
          }
          this.offerManager.clearAllOffersForTrip(io, tripId, driverId);
          break;
        }
        case STATUS.REVOKED: {
          this.driverQueue.removeTripFromAllDrivers(tripId);
          this.offerManager.clearAllOffersForTrip(io, tripId);
          this.tripEventEmitter.emitGlobally(
            io,
            EVENTS.TRIP_REVOKED,
            { tripId },
            'trip-status-update:REVOKED',
          );
          break;
        }
        case STATUS.STARTED: {
          this.tripEventEmitter.emitToTripRoom(
            io,
            tripId,
            EVENTS.TRIP_STARTED,
            { tripId, driverId },
            'trip-status-update:STARTED',
            { driverId, userId },
          );
          break;
        }
        case STATUS.COMPLETED: {
          if (driverId) {
            this.driverState.setOnline(driverId);
          }
          this.tripEventEmitter.emitToTripRoom(
            io,
            tripId,
            EVENTS.TRIP_COMPLETED,
            { tripId },
            'trip-status-update:COMPLETED',
            { driverId, userId },
          );
          this.clearTripTrackingState(tripId);
          break;
        }
        case STATUS.CANCELLED_BY_USER: {
          if (driverId) {
            this.driverState.setOnline(driverId);
          }
          this.driverQueue.removeTripFromAllDrivers(tripId);
          this.offerManager.clearAllOffersForTrip(io, tripId);
          this.tripEventEmitter.emitToTripRoom(
            io,
            tripId,
            EVENTS.TRIP_CANCELLED_BY_USER,
            { tripId },
            'trip-status-update:CANCELLED_BY_USER',
            { driverId, userId },
          );
          this.tripEventEmitter.emitGlobally(
            io,
            EVENTS.TRIP_CANCELLED_BY_USER,
            { tripId },
            'trip-status-update:CANCELLED_BY_USER',
          );
          this.clearTripTrackingState(tripId);
          break;
        }
        case STATUS.CANCELLED_BY_DRIVER: {
          if (driverId) {
            this.driverState.setOnline(driverId);
          }
          this.tripEventEmitter.emitToTripRoom(
            io,
            tripId,
            EVENTS.TRIP_CANCELLED_BY_DRIVER,
            { tripId },
            'trip-status-update:CANCELLED_BY_DRIVER',
            { driverId, userId },
          );
          this.tripEventEmitter.emitGlobally(
            io,
            EVENTS.TRIP_CANCELLED_BY_DRIVER,
            { tripId },
            'trip-status-update:CANCELLED_BY_DRIVER',
          );
          this.clearTripTrackingState(tripId);
          break;
        }
        case STATUS.REQUEST_TIMEOUT: {
          this.driverQueue.removeTripFromAllDrivers(tripId);
          this.offerManager.clearAllOffersForTrip(io, tripId);
          this.tripEventEmitter.emitGlobally(
            io,
            EVENTS.TRIP_REVOKED,
            { tripId },
            'trip-status-update:REQUEST_TIMEOUT',
          );
          break;
        }
        default: {
          return { ok: false, message: `Invalid status code: ${statusCode}` };
        }
      }

      this.logger.log(
        `[trip-status-update] Completed ${statusLabel} for trip ${tripId}`,
      );
      return { ok: true };
    } catch (error) {
      this.logger.error(
        `[trip-status-update] Error: ${error.message}`,
        error.stack,
      );
      return {
        ok: false,
        message: 'Internal server error processing status update',
      };
    }
  }
}
