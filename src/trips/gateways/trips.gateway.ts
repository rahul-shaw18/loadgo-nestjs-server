import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ConnectionManagerService } from '../services/connection-manager.service';
import { DriverQueueService } from '../services/driver-queue.service';
import { OfferManagerService } from '../services/offer-manager.service';
import { EVENTS } from '../../config/events.constant';
import { BACKEND_BASE_URL } from '../../config/app.config';

@WebSocketGateway({ cors: { origin: '*' } })
export class TripsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(TripsGateway.name);

  constructor(
    private readonly connectionManager: ConnectionManagerService,
    private readonly driverQueue: DriverQueueService,
    private readonly offerManager: OfferManagerService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway initialized');
  }

  handleConnection(client: Socket, ...args: any[]) {
    this.logger.log(`New socket connection: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    const driverId = this.connectionManager.removeDriverBySocketId(client.id);
    const userId = this.connectionManager.removeUserBySocketId(client.id);

    if (driverId) {
      this.offerManager.cleanupDriver(driverId);
    }

    if (userId) {
      this.logger.log(`User ${userId} disconnected`);
    }
  }

  private findDriverIdBySocket(socketId: string): string | null {
    const allDriverIds = this.connectionManager.getAllDriverIds();
    return (
      allDriverIds.find(
        (id) => this.connectionManager.getDriverSocketId(id) === socketId,
      ) || null
    );
  }

  @SubscribeMessage(EVENTS.REGISTER_DRIVER)
  async handleRegisterDriver(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: { driverId: string | number; tripId?: string | number },
  ) {
    const { driverId, tripId } = payload;
    if (!driverId) {
      this.logger.warn('REGISTER_DRIVER called without driverId');
      return;
    }

    this.connectionManager.addDriver(driverId, client.id);

    if (tripId) {
      client.join(this.connectionManager.tripRoom(tripId));
      this.logger.log(`Driver ${driverId} rejoined active trip ${tripId}`);
      return;
    }

    try {
      const res = await fetch(
        `${BACKEND_BASE_URL}verify-driver?driverId=${driverId}`,
      );
      const data = await res.json();
      if (data?.activeTripId) {
        client.join(this.connectionManager.tripRoom(data.activeTripId));
        this.logger.log(
          `Driver ${driverId} verified with active trip ${data.activeTripId}`,
        );
        return;
      }
    } catch (err) {
      this.logger.error(`Failed to verify driver ${driverId}: ${err.message}`);
    }

    try {
      const res = await fetch(`${BACKEND_BASE_URL}searching-trips`);
      const searchingTrips = await res.json();

      if (Array.isArray(searchingTrips) && searchingTrips.length > 0) {
        this.logger.log(
          `Found ${searchingTrips.length} searching trip(s) for driver ${driverId}`,
        );
        searchingTrips.forEach((trip) => {
          this.driverQueue.addTripToDriver(driverId, trip.id);
        });
        this.offerManager.offerNextTrip(this.server, driverId);
      } else {
        this.logger.log(`No searching trips available for driver ${driverId}`);
      }
    } catch (err) {
      this.logger.error(`Failed to fetch searching trips: ${err.message}`);
    }
  }

  @SubscribeMessage(EVENTS.REGISTER_USER)
  async handleRegisterUser(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: { userId: string | number; tripId?: string | number },
  ) {
    const { userId, tripId } = payload;
    if (!userId) {
      this.logger.warn('REGISTER_USER called without userId');
      return;
    }

    this.connectionManager.addUser(userId, client.id);

    if (tripId) {
      client.join(this.connectionManager.tripRoom(tripId));
    }

    try {
      const res = await fetch(
        `${BACKEND_BASE_URL}verify-user?userId=${userId}`,
      );
      const data = await res.json();
      if (data?.activeTripId) {
        client.join(this.connectionManager.tripRoom(data.activeTripId));
        this.logger.log(
          `User ${userId} verified with active trip ${data.activeTripId}`,
        );
      }
    } catch (err) {
      this.logger.error(`Failed to verify user ${userId}: ${err.message}`);
    }
  }

  @SubscribeMessage(EVENTS.ACCEPT_OFFER)
  async handleAcceptOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { tripId: number },
  ) {
    const { tripId } = payload;
    const driverId = this.findDriverIdBySocket(client.id);
    if (!driverId) {
      this.logger.warn('ACCEPT_OFFER from unknown socket');
      return;
    }

    const result = this.offerManager.handleAccept(driverId, tripId);
    if (!result.valid) {
      this.offerManager.clearOffer(driverId);
      this.offerManager.offerNextTrip(this.server, driverId);
      return;
    }

    try {
      const res = await fetch(`${BACKEND_BASE_URL}accept-trip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId, driverId }),
      });
      const data = await res.json();

      if (data?.success) {
        this.logger.log(
          `Trip ${tripId} accepted by driver ${driverId} — confirmed`,
        );
      } else {
        this.logger.warn(
          `Trip ${tripId} accept failed for driver ${driverId}: ${data?.message}`,
        );
        this.driverQueue.removeTripFromDriver(driverId, tripId);
        this.offerManager.offerNextTrip(this.server, driverId);
      }
    } catch (err) {
      this.logger.error(`Failed to accept trip ${tripId}: ${err.message}`);
      this.driverQueue.removeTripFromDriver(driverId, tripId);
      this.offerManager.offerNextTrip(this.server, driverId);
    }
  }

  @SubscribeMessage(EVENTS.REJECT_OFFER)
  handleRejectOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { tripId: number },
  ) {
    const { tripId } = payload;
    const driverId = this.findDriverIdBySocket(client.id);
    if (!driverId) {
      this.logger.warn('REJECT_OFFER from unknown socket');
      return;
    }

    const offer = this.offerManager.getOffer(driverId);
    if (!offer || offer.tripId !== tripId) {
      this.logger.warn(
        `Driver ${driverId} rejected trip ${tripId} but current offer is ${offer ? offer.tripId : 'none'}`,
      );
      return;
    }

    this.offerManager.handleReject(this.server, driverId);
  }
}
