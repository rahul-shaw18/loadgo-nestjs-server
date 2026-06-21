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
import { BackendApiService } from '../services/backend-api.service';
import { LocationCacheService } from '../services/location-cache.service';
import { DisconnectGraceService } from '../services/disconnect-grace.service';
import { EVENTS } from '../../config/events.constant';
import { LOCATION_UPDATE_THROTTLE_MS } from '../../config/app.config';
import { normalizeTripId, TripId, tripIdKey, tripIdsEqual } from '../utils/trip-id.util';

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
    string,
    { tripId: TripId; driverId: string | number }
  >();

  // Throttle high-frequency GPS updates per driver
  private lastLocationUpdateAt = new Map<string, number>();

  constructor(
    private readonly connectionManager: ConnectionManagerService,
    private readonly driverQueue: DriverQueueService,
    private readonly offerManager: OfferManagerService,
    private readonly backendApi: BackendApiService,
    private readonly locationCache: LocationCacheService,
    private readonly disconnectGrace: DisconnectGraceService,
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
      this.offerManager.onDriverDisconnect(driverId);
      this.disconnectGrace.scheduleDriverCleanup(driverId, () => {
        this.offerManager.cleanupDriver(driverId);
      });
    }

    if (userId) {
      this.logger.log(`User ${userId} disconnected`);
    }
  }

  private async resolveActiveTripId(
    providedTripId: string | number | undefined,
    fetchActiveTrip: () => Promise<TripId | null>,
  ): Promise<TripId | null> {
    const normalizedProvided = normalizeTripId(providedTripId);
    if (normalizedProvided) {
      return normalizedProvided;
    }

    return fetchActiveTrip();
  }

  private syncUserTripState(
    client: Socket,
    userId: string | number,
    tripId: TripId,
  ) {
    const cachedAcceptance = this.recentAcceptances.get(tripIdKey(tripId));
    if (cachedAcceptance) {
      this.logger.log(
        `User ${userId} joined room late; sync-pushing acceptance for trip ${tripId}`,
      );
      client.emit(EVENTS.TRIP_ACCEPTED, cachedAcceptance);
    }

    const lastLocation = this.locationCache.get(tripId);
    if (lastLocation) {
      this.logger.log(
        `User ${userId} sync-pushing last known location for trip ${tripId}`,
      );
      client.emit(EVENTS.DRIVER_LOCATION_UPDATE, lastLocation);
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

  private isValidCoordinate(latitude: number, longitude: number): boolean {
    return (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180
    );
  }

  @SubscribeMessage(EVENTS.DRIVER_LOCATION)
  handleDriverLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: {
      tripId: number | string;
      latitude: number;
      longitude: number;
      heading?: number;
      speed?: number;
      timestamp?: number;
    },
  ): { ok: boolean; message?: string } {
    const driverId = this.findDriverIdBySocket(client.id);
    if (!driverId) {
      this.logger.warn(
        `${EVENTS.DRIVER_LOCATION} from unregistered socket ${client.id}`,
      );
      return { ok: false, message: 'Driver not registered' };
    }

    const tripId = normalizeTripId(payload?.tripId);
    const latitude = Number(payload?.latitude);
    const longitude = Number(payload?.longitude);

    if (!tripId) {
      this.logger.warn(
        `Driver ${driverId} sent ${EVENTS.DRIVER_LOCATION} with invalid tripId`,
      );
      return { ok: false, message: 'Invalid tripId' };
    }

    if (!this.isValidCoordinate(latitude, longitude)) {
      this.logger.warn(
        `Driver ${driverId} sent ${EVENTS.DRIVER_LOCATION} with invalid coordinates`,
      );
      return { ok: false, message: 'Invalid coordinates' };
    }

    const room = this.connectionManager.tripRoom(tripId);
    if (!client.rooms.has(room)) {
      this.logger.warn(
        `Driver ${driverId} sent ${EVENTS.DRIVER_LOCATION} for trip ${tripId} but is not in ${room}`,
      );
      return { ok: false, message: 'Driver not in trip room' };
    }

    const now = Date.now();
    const lastUpdateAt = this.lastLocationUpdateAt.get(driverId) ?? 0;
    if (now - lastUpdateAt < LOCATION_UPDATE_THROTTLE_MS) {
      return { ok: true, message: 'Throttled' };
    }
    this.lastLocationUpdateAt.set(driverId, now);

    const update = {
      tripId,
      driverId,
      latitude,
      longitude,
      ...(payload.heading !== undefined && { heading: Number(payload.heading) }),
      ...(payload.speed !== undefined && { speed: Number(payload.speed) }),
      timestamp: payload.timestamp ?? now,
    };

    this.logger.debug(
      `Emitting ${EVENTS.DRIVER_LOCATION_UPDATE} to room ${room}: ${JSON.stringify(update)}`,
    );
    this.server.to(room).emit(EVENTS.DRIVER_LOCATION_UPDATE, update);
    this.locationCache.set(tripId, update);
    this.backendApi.persistDriverLocation(update);

    return { ok: true };
  }

  @SubscribeMessage(EVENTS.REGISTER_DRIVER)
  async handleRegisterDriver(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: { driverId: string | number; tripId?: string | number },
  ) {
    this.logger.log(`Received ${EVENTS.REGISTER_DRIVER} from socket ${client.id} with payload: ${JSON.stringify(payload)}`);
    const { driverId, tripId } = payload;
    if (!driverId) {
      this.logger.warn('REGISTER_DRIVER called without driverId');
      return;
    }

    this.connectionManager.addDriver(driverId, client.id);
    this.disconnectGrace.cancelDriverCleanup(driverId);

    const activeTripId = await this.resolveActiveTripId(tripId, () =>
      this.backendApi.fetchDriverActiveTrip(driverId),
    );

    if (activeTripId) {
      client.join(this.connectionManager.tripRoom(activeTripId));
      this.logger.log(
        `Driver ${driverId} joined active trip ${activeTripId}`,
      );
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
    this.logger.log(`Received ${EVENTS.REGISTER_USER} from socket ${client.id} with payload: ${JSON.stringify(payload)}`);
    const { userId, tripId } = payload;
    if (!userId) {
      this.logger.warn('REGISTER_USER called without userId');
      return;
    }

    this.connectionManager.addUser(userId, client.id);

    const activeTripId = await this.resolveActiveTripId(tripId, () =>
      this.backendApi.fetchUserActiveTrip(userId),
    );

    if (activeTripId) {
      client.join(this.connectionManager.tripRoom(activeTripId));
      this.logger.log(`User ${userId} joined trip room ${activeTripId}`);
      this.syncUserTripState(client, userId, activeTripId);
    } else {
      this.logger.log(`User ${userId} registered (no active trip)`);
    }
  }

  @SubscribeMessage(EVENTS.TRIP_ACCEPTED)
  async handleAcceptOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { tripId: number | string },
  ) {
    this.logger.log(`Received ${EVENTS.TRIP_ACCEPTED} from socket ${client.id} with payload: ${JSON.stringify(payload)}`);
    const { tripId } = payload;
    const normalizedTripId = normalizeTripId(tripId);
    const driverId = this.findDriverIdBySocket(client.id);
    if (!driverId) {
      this.logger.warn('TRIP_ACCEPTED from unknown socket');
      return;
    }

    if (!normalizedTripId) {
      this.logger.warn('TRIP_ACCEPTED called with invalid tripId');
      return;
    }

    const result = this.offerManager.handleAccept(driverId, normalizedTripId);
    if (!result.valid) {
      this.offerManager.clearOffer(driverId);
      this.offerManager.offerNextTrip(this.server, driverId);
      return;
    }

    try {
      const accepted = await this.backendApi.confirmTripAcceptance(
        normalizedTripId,
        driverId,
      );
      if (!accepted) {
        this.driverQueue.removeTripFromDriver(driverId, normalizedTripId);
        this.offerManager.offerNextTrip(this.server, driverId);
        return;
      }

      this.logger.log(
        `Trip ${normalizedTripId} accepted by driver ${driverId} — confirmed by backend`,
      );

      client.join(this.connectionManager.tripRoom(normalizedTripId));

      this.logger.log(`Emitting ${EVENTS.TRIP_ACCEPTED} to room ${this.connectionManager.tripRoom(normalizedTripId)}: ${JSON.stringify({ tripId: normalizedTripId, driverId })}`);
      this.server
        .to(this.connectionManager.tripRoom(normalizedTripId))
        .emit(EVENTS.TRIP_ACCEPTED, {
          tripId: normalizedTripId,
          driverId: driverId,
        });

      this.recentAcceptances.set(tripIdKey(normalizedTripId), {
        tripId: normalizedTripId,
        driverId,
      });
      setTimeout(
        () => {
          this.recentAcceptances.delete(tripIdKey(normalizedTripId));
        },
        5 * 60 * 1000,
      );

      this.offerManager.clearAllOffersForTrip(this.server, normalizedTripId);
    } catch (err) {
      this.logger.error(
        `Failed to accept trip ${normalizedTripId}: ${err.message}`,
      );
      this.driverQueue.removeTripFromDriver(driverId, normalizedTripId);
      this.offerManager.offerNextTrip(this.server, driverId);
    }
  }

  @SubscribeMessage(EVENTS.TRIP_REJECTED)
  handleRejectOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { tripId: number | string },
  ) {
    this.logger.log(`Received ${EVENTS.TRIP_REJECTED} from socket ${client.id} with payload: ${JSON.stringify(payload)}`);
    const normalizedTripId = normalizeTripId(payload?.tripId);
    const driverId = this.findDriverIdBySocket(client.id);
    if (!driverId) {
      this.logger.warn('TRIP_REJECTED from unknown socket');
      return;
    }

    if (!normalizedTripId) {
      this.logger.warn('TRIP_REJECTED called with invalid tripId');
      return;
    }

    const offer = this.offerManager.getOffer(driverId);
    if (!offer || !tripIdsEqual(offer.tripId, normalizedTripId)) {
      this.logger.warn(
        `Driver ${driverId} rejected trip ${normalizedTripId} but current offer is ${offer ? offer.tripId : 'none'}`,
      );
      return;
    }

    this.offerManager.handleReject(this.server, driverId);
  }

  @SubscribeMessage(EVENTS.TRIP_CANCELLED_BY_USER)
  handleTripCancelledByUser(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { tripId: number | string; reason?: string; tag?: string },
  ) {
    this.logger.log(`[Event Emitted From User] ${EVENTS.TRIP_CANCELLED_BY_USER} via socket ${client.id} - Payload: ${JSON.stringify(payload)}`);
    const normalizedTripId = normalizeTripId(payload?.tripId);
    if (!normalizedTripId) {
      this.logger.warn('TRIP_CANCELLED_BY_USER called with invalid tripId');
      return;
    }

    this.server.to(this.connectionManager.tripRoom(normalizedTripId)).emit(
      EVENTS.TRIP_CANCELLED_BY_USER,
      { ...payload, tripId: normalizedTripId },
    );

    this.offerManager.clearAllOffersForTrip(this.server, normalizedTripId);
    this.locationCache.clear(normalizedTripId);
  }
}
