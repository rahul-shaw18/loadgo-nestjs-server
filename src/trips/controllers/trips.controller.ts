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
      'Adds the trip to each eligible driver\'s queue and, if the driver has no active offer, ' +
      'immediately emits an OFFER_TRIP socket event with a 30-second screen timer.',
  })
  @ApiBody({ type: NotifyNewTripDto })
  @ApiResponse({ status: 200, description: 'Trip queued successfully', schema: { example: { ok: true } } })
  notifyNewTrip(@Body() payload: NotifyNewTripDto, @Res() res: Response) {
    const { tripId, drivers } = payload;
    const io = this.tripsGateway.server;

    this.logger.log(
      `New trip ${tripId} → notifying ${drivers.length} driver(s): [${drivers.join(', ')}]`,
    );

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
      'Status codes: 2=ACCEPTED (joins rooms, emits TRIP_ACCEPTED + CLOSE_RIDE_REQ, cleans queues), ' +
      '3=REVOKED (cleans queues, emits RIDE_REVOKED), ' +
      '4=STARTED (emits TRIP_STARTED to room), ' +
      '5=COMPLETED (emits TRIP_COMPLETED to room), ' +
      '6=CANCELLED_BY_USER (cleans queues, emits TRIP_CANCELLED + RIDE_CANCEL_BY_USER), ' +
      '7=CANCELLED_BY_DRIVER (emits TRIP_CANCELLED + RIDE_CANCEL_BY_DRIVER), ' +
      '8=REQUEST_TIMEOUT (cleans queues, emits RIDE_REVOKED).',
  })
  @ApiBody({ type: TripStatusUpdateDto })
  @ApiResponse({ status: 200, description: 'Status updated successfully', schema: { example: { ok: true } } })
  @ApiResponse({ status: 400, description: 'Invalid status code', schema: { example: { ok: false, message: 'Invalid status code: 99' } } })
  tripStatusUpdate(@Body() payload: TripStatusUpdateDto, @Res() res: Response) {
    const { status, tripId, driverId, userId } = payload;
    const io = this.tripsGateway.server;
    const statusCode = Number(status);

    this.logger.log(`Trip status update: ${statusCode} for trip ${tripId}`);

    switch (statusCode) {
      case STATUS.ACCEPTED: {
        this.connectionManager.joinDriverToTripRoom(io, driverId as string | number, tripId);
        this.connectionManager.joinUserToTripRoom(io, userId as string | number, tripId);

        io.to(this.connectionManager.tripRoom(tripId)).emit(
          EVENTS.TRIP_ACCEPTED,
          {
            tripId,
            driverId,
          },
        );

        io.emit(EVENTS.CLOSE_RIDE_REQ, { driverId, tripId });
        this.driverQueue.removeTripFromAllDrivers(tripId);
        this.offerManager.clearAllOffersForTrip(io, tripId);
        break;
      }
      case STATUS.REVOKED: {
        this.driverQueue.removeTripFromAllDrivers(tripId);
        this.offerManager.clearAllOffersForTrip(io, tripId);
        io.emit(EVENTS.RIDE_REVOKED, { tripId });
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
          EVENTS.TRIP_CANCELLED,
          {
            tripId,
          },
        );
        io.emit(EVENTS.RIDE_CANCEL_BY_USER, { tripId });
        break;
      }
      case STATUS.CANCELLED_BY_DRIVER: {
        io.to(this.connectionManager.tripRoom(tripId)).emit(
          EVENTS.TRIP_CANCELLED,
          {
            tripId,
          },
        );
        io.emit(EVENTS.RIDE_CANCEL_BY_DRIVER, { tripId });
        break;
      }
      case STATUS.REQUEST_TIMEOUT: {
        this.driverQueue.removeTripFromAllDrivers(tripId);
        this.offerManager.clearAllOffersForTrip(io, tripId);
        io.emit(EVENTS.RIDE_REVOKED, { tripId });
        break;
      }
      default: {
        return res
          .status(HttpStatus.BAD_REQUEST)
          .json({ ok: false, message: `Invalid status code: ${statusCode}` });
      }
    }

    return res.json({ ok: true });
  }
}
