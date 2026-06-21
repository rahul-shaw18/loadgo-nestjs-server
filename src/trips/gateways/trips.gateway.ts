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
import { TripParticipantsService } from '../services/trip-participants.service';
import { TripEventEmitterService } from '../services/trip-event-emitter.service';
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
    private readonly tripParticipants: TripParticipantsService,
    private readonly tripEventEmitter: TripEventEmitterService,
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
      this.logger.log(
        `[disconnect] Driver ${driverId} disconnected (socket ${client.id}) — scheduling grace cleanup`,
      );
      this.offerManager.onDriverDisconnect(driverId);
      this.disconnectGrace.scheduleDriverCleanup(driverId, () => {
        this.offerManager.cleanupDriver(driverId);
      });
    }

    if (userId) {
      this.logger.log(
        `[disconnect] User ${userId} disconnected (socket ${client.id})`,
      );
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
    this.logger.log(
      `[rejoin-sync] User ${userId} rejoined trip ${tripId} — checking cached state`,
    );

    const cachedAcceptance = this.recentAcceptances.get(tripIdKey(tripId));
    if (cachedAcceptance) {
      this.logger.log(
        `[rejoin-sync] Pushing ${EVENTS.TRIP_ACCEPTED} to user ${userId} for trip ${tripId}: ${JSON.stringify(cachedAcceptance)}`,
      );
      client.emit(EVENTS.TRIP_ACCEPTED, cachedAcceptance);
    } else {
      this.logger.log(
        `[rejoin-sync] No cached acceptance for trip ${tripId} — user ${userId} will rely on room events or HTTP fetch`,
      );
    }

    const lastLocation = this.locationCache.get(tripId);
    if (lastLocation) {
      this.logger.log(
        `[rejoin-sync] Pushing ${EVENTS.DRIVER_LOCATION_UPDATE} to user ${userId} for trip ${tripId}: ${JSON.stringify(lastLocation)}`,
      );
      client.emit(EVENTS.DRIVER_LOCATION_UPDATE, lastLocation);
    } else {
      this.logger.log(
        `[rejoin-sync] No cached location for trip ${tripId}`,
      );
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

    this.logger.log(
      `[location] Emitting ${EVENTS.DRIVER_LOCATION_UPDATE} to room ${room} for trip ${tripId}`,
    );
    this.tripEventEmitter.emitToTripRoom(
      this.server,
      tripId,
      EVENTS.DRIVER_LOCATION_UPDATE,
      update,
      'driver-location',
      { driverId },
    );
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
        `[rejoin] Driver ${driverId} joined active trip ${activeTripId} | ${this.tripEventEmitter.getRoomDebugInfo(this.server, activeTripId)}`,
      );
    } else {
      this.logger.log(`[rejoin] Driver ${driverId} registered (no active trip)`);
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
      this.logger.log(
        `[rejoin] User ${userId} joined trip room ${activeTripId} | ${this.tripEventEmitter.getRoomDebugInfo(this.server, activeTripId)}`,
      );
      this.tripParticipants.setUser(activeTripId, userId);
      this.syncUserTripState(client, userId, activeTripId);
    } else {
      this.logger.log(`[rejoin] User ${userId} registered (no active trip)`);
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
      this.logger.log(
        `[accept] Confirming trip ${normalizedTripId} acceptance with backend for driver ${driverId}`,
      );
      const accepted = await this.backendApi.confirmTripAcceptance(
        normalizedTripId,
        driverId,
      );
      if (!accepted) {
        this.logger.warn(
          `[accept] Backend rejected trip ${normalizedTripId} for driver ${driverId} — ${EVENTS.TRIP_ACCEPTED} will NOT be emitted`,
        );
        this.driverQueue.removeTripFromDriver(driverId, normalizedTripId);
        this.offerManager.offerNextTrip(this.server, driverId);
        return;
      }

      this.tripParticipants.setDriver(normalizedTripId, driverId);

      const acceptPayload = {
        tripId: normalizedTripId,
        driverId,
      };

      this.tripEventEmitter.emitToTripRoom(
        this.server,
        normalizedTripId,
        EVENTS.TRIP_ACCEPTED,
        acceptPayload,
        'socket-accept',
        { driverId },
      );

      const participants = this.tripParticipants.get(normalizedTripId);
      if (participants?.userId) {
        this.tripEventEmitter.emitDirectToUser(
          this.server,
          participants.userId,
          EVENTS.TRIP_ACCEPTED,
          acceptPayload,
          'socket-accept:fallback',
        );
      } else {
        this.logger.warn(
          `[accept] No userId registered for trip ${normalizedTripId} — user must rejoin or fetch via HTTP`,
        );
      }

      this.recentAcceptances.set(tripIdKey(normalizedTripId), acceptPayload);
      setTimeout(
        () => {
          this.recentAcceptances.delete(tripIdKey(normalizedTripId));
          this.logger.log(
            `[accept] Cleared acceptance cache for trip ${normalizedTripId}`,
          );
        },
        5 * 60 * 1000,
      );

      this.tripEventEmitter.emitGlobally(
        this.server,
        EVENTS.TRIP_ACCEPTED_BY_OTHER_DRIVER,
        { driverId, tripId: normalizedTripId },
        'socket-accept',
      );

      this.offerManager.clearAllOffersForTrip(this.server, normalizedTripId);

      this.logger.log(
        `[accept] Trip ${normalizedTripId} acceptance complete | ${this.tripEventEmitter.getRoomDebugInfo(this.server, normalizedTripId)}`,
      );
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

    this.tripEventEmitter.emitToTripRoom(
      this.server,
      normalizedTripId,
      EVENTS.TRIP_CANCELLED_BY_USER,
      { ...payload, tripId: normalizedTripId },
      'user-cancel',
    );

    this.offerManager.clearAllOffersForTrip(this.server, normalizedTripId);
    this.locationCache.clear(normalizedTripId);
    this.tripParticipants.clear(normalizedTripId);
    this.logger.log(
      `[user-cancel] Trip ${normalizedTripId} cancelled by user — tracking state cleared`,
    );
  }
}
