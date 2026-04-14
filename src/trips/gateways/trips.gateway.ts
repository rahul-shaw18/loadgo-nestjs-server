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

  // Cache of recently accepted trips to handle users who join a room "late"
  // Map<tripId, { tripId, driverId }>
  private recentAcceptances = new Map<
    number,
    { tripId: number; driverId: string | number }
  >();

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
    } else {
      this.logger.log(`Driver ${driverId} registered (no active trip)`);
    }

    // Trigger the offer flow for any trips that might be in their queue
    this.offerManager.offerNextTrip(this.server, driverId);
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
      const numericTripId = Number(tripId);
      client.join(this.connectionManager.tripRoom(numericTripId));
      this.logger.log(`User ${userId} joined trip room ${numericTripId}`);

      // STATE SYNC ON JOIN: If this trip was already accepted, notify the user immediately
      const cachedAcceptance = this.recentAcceptances.get(numericTripId);
      if (cachedAcceptance) {
        this.logger.log(
          `User ${userId} joined room late; sync-pushing acceptance for trip ${numericTripId}`,
        );
        client.emit(EVENTS.TRIP_ACCEPTED, cachedAcceptance);
      }
    } else {
      this.logger.log(`User ${userId} registered (no active trip)`);
    }
  }

  @SubscribeMessage(EVENTS.TRIP_ACCEPTED)
  async handleAcceptOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { tripId: number },
  ) {
    const { tripId } = payload;
    const numericTripId = Number(tripId);
    const driverId = this.findDriverIdBySocket(client.id);
    if (!driverId) {
      this.logger.warn('TRIP_ACCEPTED from unknown socket');
      return;
    }

    const result = this.offerManager.handleAccept(driverId, numericTripId);
    if (!result.valid) {
      this.offerManager.clearOffer(driverId);
      this.offerManager.offerNextTrip(this.server, driverId);
      return;
    }

    try {
      const res = await fetch(`${BACKEND_BASE_URL}patchLiveTripData`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: numericTripId, driverId }),
      });
      if (!res.ok) {
        this.logger.warn(
          `accept-trip returned HTTP ${res.status} for trip ${numericTripId}`,
        );
        this.driverQueue.removeTripFromDriver(driverId, numericTripId);
        this.offerManager.offerNextTrip(this.server, driverId);
        return;
      }
      const responseText = await res.text();
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        this.logger.error(
          `Failed to parse JSON response from backend for trip ${numericTripId}. Raw response: ${responseText}`,
        );
        this.driverQueue.removeTripFromDriver(driverId, numericTripId);
        this.offerManager.offerNextTrip(this.server, driverId);
        return;
      }

      const isSuccess =
        data?.success === true ||
        data?.status === 'success' ||
        data?.message?.toLowerCase().includes('successfully');

      if (isSuccess) {
        this.logger.log(
          `Trip ${numericTripId} accepted by driver ${driverId} — confirmed (Backend: ${data?.message || 'OK'})`,
        );

        // Notify all participants in the trip room (User and the accepting Driver)
        // Ensure driver is in the room before emitting
        client.join(this.connectionManager.tripRoom(numericTripId));

        this.server
          .to(this.connectionManager.tripRoom(numericTripId))
          .emit(EVENTS.TRIP_ACCEPTED, {
            tripId: numericTripId,
            driverId: driverId,
          });

        // CACHE ACCEPTANCE: Store for 5 minutes to handle "late joins" from the user
        this.recentAcceptances.set(numericTripId, {
          tripId: numericTripId,
          driverId,
        });
        setTimeout(
          () => {
            this.recentAcceptances.delete(numericTripId);
          },
          5 * 60 * 1000,
        );

        // Stop offering this trip to other drivers and clear their screen timers
        this.offerManager.clearAllOffersForTrip(this.server, numericTripId);
      } else {
        this.logger.warn(
          `Trip ${numericTripId} accept failed for driver ${driverId}. ` +
            `Full Response: ${JSON.stringify(data)}`,
        );
        this.driverQueue.removeTripFromDriver(driverId, numericTripId);
        this.offerManager.offerNextTrip(this.server, driverId);
      }
    } catch (err) {
      this.logger.error(
        `Failed to accept trip ${numericTripId}: ${err.message}`,
      );
      this.driverQueue.removeTripFromDriver(driverId, numericTripId);
      this.offerManager.offerNextTrip(this.server, driverId);
    }
  }

  @SubscribeMessage(EVENTS.TRIP_REJECTED)
  handleRejectOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { tripId: number },
  ) {
    const { tripId } = payload;
    const numericTripId = Number(tripId);
    const driverId = this.findDriverIdBySocket(client.id);
    if (!driverId) {
      this.logger.warn('TRIP_REJECTED from unknown socket');
      return;
    }

    const offer = this.offerManager.getOffer(driverId);
    if (!offer || Number(offer.tripId) !== numericTripId) {
      this.logger.warn(
        `Driver ${driverId} rejected trip ${numericTripId} but current offer is ${offer ? offer.tripId : 'none'}`,
      );
      return;
    }

    this.offerManager.handleReject(this.server, driverId);
  }
}
