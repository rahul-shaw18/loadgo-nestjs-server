import {
  Controller,
  Post,
  Body,
  Logger,
  Res,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { DriverQueueService } from '../services/driver-queue.service';
import { OfferManagerService } from '../services/offer-manager.service';
import { ConnectionManagerService } from '../services/connection-manager.service';
import { NotifyNewTripDto, TripStatusUpdateDto } from '../dto/trip.dto';
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

@ApiTags('Trips')
@Controller()
export class TripsController {
  private readonly logger = new Logger(TripsController.name);

  constructor(
    private readonly driverQueue: DriverQueueService,
    private readonly offerManager: OfferManagerService,
    private readonly connectionManager: ConnectionManagerService,
    private readonly tripsGateway: TripsGateway, // Used to access the server
  ) {}

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
    const { tripId, drivers, userId } = payload;
    const io = this.tripsGateway.server;

    // Join the user to the trip room immediately if they are online and the server is ready
    if (userId && io) {
      this.connectionManager.joinUserToTripRoom(io, userId, tripId);
    }

    this.logger.log(
      `New trip ${tripId} → notifying ${drivers.length} driver(s): [${drivers.join(', ')}]`,
    );

    // If socket server is not ready yet, we can't offer trips now.
    // However, they are still added to the queue, and once drivers log in,
    // they will catch up via the handleRegisterDriver logic.
    if (!io) {
      this.logger.warn(
        `Socket.IO server not ready for trip ${tripId}. Drivers will catch up on login.`,
      );
      return res.json({ ok: true });
    }

    drivers.forEach((driverId) => {
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
    try {
      const { tripId, status, driverId, userId } = payload;
      const io = this.tripsGateway.server;
      const statusCode = Number(status);

      this.logger.log(`Trip status update: ${statusCode} for trip ${tripId}`);

      // Defensive check: ensure socket server is available
      if (!io) {
        this.logger.error(
          'Socket.IO server is not initialized in TripsGateway',
        );
        return { ok: false, message: 'Socket server not ready' };
      }

      switch (statusCode) {
        case STATUS.ACCEPTED: {
          this.connectionManager.joinDriverToTripRoom(
            io,
            driverId as string | number,
            tripId,
          );
          this.connectionManager.joinUserToTripRoom(
            io,
            userId as string | number,
            tripId,
          );

          io.to(this.connectionManager.tripRoom(tripId)).emit(
            EVENTS.TRIP_ACCEPTED,
            {
              tripId,
              driverId,
            },
          );

          io.emit(EVENTS.TRIP_ACCEPTED_BY_OTHER_DRIVER, { driverId, tripId });
          this.driverQueue.removeTripFromAllDrivers(tripId);
          this.offerManager.clearAllOffersForTrip(io, tripId);
          break;
        }
        case STATUS.REVOKED: {
          this.driverQueue.removeTripFromAllDrivers(tripId);
          this.offerManager.clearAllOffersForTrip(io, tripId);
          io.emit(EVENTS.TRIP_REVOKED, { tripId });
          break;
        }
        case STATUS.STARTED: {
          io.to(this.connectionManager.tripRoom(tripId)).emit(
            EVENTS.TRIP_STARTED,
            {
              tripId,
              driverId,
            },
          );
          break;
        }
        case STATUS.COMPLETED: {
          io.to(this.connectionManager.tripRoom(tripId)).emit(
            EVENTS.TRIP_COMPLETED,
            {
              tripId,
            },
          );
          break;
        }
        case STATUS.CANCELLED_BY_USER: {
          this.driverQueue.removeTripFromAllDrivers(tripId);
          this.offerManager.clearAllOffersForTrip(io, tripId);
          io.to(this.connectionManager.tripRoom(tripId)).emit(
            EVENTS.TRIP_CANCELLED_BY_USER,
            {
              tripId,
            },
          );
          io.emit(EVENTS.TRIP_CANCELLED_BY_USER, { tripId });
          break;
        }
        case STATUS.CANCELLED_BY_DRIVER: {
          io.to(this.connectionManager.tripRoom(tripId)).emit(
            EVENTS.TRIP_CANCELLED_BY_DRIVER,
            {
              tripId,
            },
          );
          io.emit(EVENTS.TRIP_CANCELLED_BY_DRIVER, { tripId });
          break;
        }
        case STATUS.REQUEST_TIMEOUT: {
          this.driverQueue.removeTripFromAllDrivers(tripId);
          this.offerManager.clearAllOffersForTrip(io, tripId);
          io.emit(EVENTS.TRIP_REVOKED, { tripId });
          break;
        }
        default: {
          return { ok: false, message: `Invalid status code: ${statusCode}` };
        }
      }

      return { ok: true };
    } catch (error) {
      this.logger.error(
        `Error in tripStatusUpdate: ${error.message}`,
        error.stack,
      );
      return {
        ok: false,
        message: 'Internal server error processing status update',
      };
    }
  }
}
