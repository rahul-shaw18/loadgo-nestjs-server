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
import { TripLifecycleService } from '../services/trip-lifecycle.service';
import type { SocketAck } from '../services/trip-lifecycle.service';
import { DriverStateService } from '../services/driver-state.service';
import { TripRejectionCooldownService } from '../services/trip-rejection-cooldown.service';
import { SocketRegistrationService } from '../services/socket-registration.service';
import { DriverDisconnectTrackerService } from '../services/driver-disconnect-tracker.service';
import { PendingTerminalService } from '../services/pending-terminal.service';
import { TripAcceptanceCacheService } from '../services/trip-acceptance-cache.service';
import { EVENTS } from '../../config/events.constant';
import {
  LOCATION_UPDATE_THROTTLE_MS,
  SOCKET_PING_INTERVAL_MS,
  SOCKET_PING_TIMEOUT_MS,
  TRIP_STATUS,
} from '../../config/app.config';
import { normalizeTripId, TripId, tripIdKey, tripIdsEqual } from '../utils/trip-id.util';
import {
  DriverCoordinatePayload,
  DriverCoordinates,
  resolveDriverCoordinates,
} from '../utils/coordinates.util';
import {
  TripCompletedSocketDto,
  TripStartedSocketDto,
} from '../dto/trip.dto';

@WebSocketGateway({
  cors: { origin: '*' },
  pingInterval: SOCKET_PING_INTERVAL_MS,
  pingTimeout: SOCKET_PING_TIMEOUT_MS,
})
export class TripsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(TripsGateway.name);

  // Throttle high-frequency GPS updates per driver
  private lastLocationUpdateAt = new Map<string, number>();

  private readonly driverRegisterChains = new Map<string, Promise<void>>();

  constructor(
    private readonly connectionManager: ConnectionManagerService,
    private readonly driverQueue: DriverQueueService,
    private readonly offerManager: OfferManagerService,
    private readonly backendApi: BackendApiService,
    private readonly locationCache: LocationCacheService,
    private readonly disconnectGrace: DisconnectGraceService,
    private readonly tripParticipants: TripParticipantsService,
    private readonly tripEventEmitter: TripEventEmitterService,
    private readonly tripLifecycle: TripLifecycleService,
    private readonly driverState: DriverStateService,
    private readonly rejectionCooldown: TripRejectionCooldownService,
    private readonly socketRegistration: SocketRegistrationService,
    private readonly disconnectTracker: DriverDisconnectTrackerService,
    private readonly pendingTerminal: PendingTerminalService,
    private readonly acceptanceCache: TripAcceptanceCacheService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway initialized');
    this.rejectionCooldown.setExpireHandler((driverId, tripId) =>
      this.handleRejectionCooldownExpired(driverId, tripId),
    );
  }

  handleConnection(client: Socket, ...args: any[]) {
    this.logger.log(`New socket connection: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.socketRegistration.clearSocket(client.id);
    this.offerManager.clearSocketOfferTracking(client.id);

    const driverId = this.connectionManager.removeDriverBySocketId(client.id);
    const userId = this.connectionManager.removeUserBySocketId(client.id);

    if (driverId) {
      const activeTripId = this.driverState.getActiveTripId(driverId);
      const onActiveTrip = this.driverState.isOnTrip(driverId) && activeTripId;

      if (onActiveTrip) {
        this.logger.log(
          `[disconnect] Driver ${driverId} disconnected during active trip ${activeTripId} (socket ${client.id})`,
        );
        this.offerManager.onDriverDisconnectDuringActiveTrip(driverId);
        this.disconnectTracker.recordDisconnect(driverId, client.id);
        this.emitDriverConnectionEvent(
          EVENTS.DRIVER_DISCONNECTED,
          activeTripId,
          driverId,
        );
      } else {
        this.logger.log(
          `[disconnect] Driver ${driverId} disconnected (socket ${client.id}) — scheduling grace cleanup`,
        );
        this.offerManager.onDriverDisconnect(driverId);
        this.disconnectGrace.scheduleDriverCleanup(driverId, () => {
          this.offerManager.cleanupDriver(driverId);
        });
      }
    }

    if (userId) {
      this.logger.log(
        `[disconnect] User ${userId} disconnected (socket ${client.id})`,
      );
    }
  }

  private async withDriverRegisterLock<T>(
    driverId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.driverRegisterChains.get(driverId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => gate);
    this.driverRegisterChains.set(driverId, chained);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.driverRegisterChains.get(driverId) === chained) {
        this.driverRegisterChains.delete(driverId);
      }
    }
  }

  private async resolveRestoredTripId(
    entityId: string | number,
    providedTripId: TripId | null | undefined,
    skipTripRestore: boolean,
    fetchActiveTrip: () => Promise<TripId | null>,
  ): Promise<TripId | null> {
    if (skipTripRestore) {
      return normalizeTripId(providedTripId ?? undefined);
    }

    const normalizedProvided = normalizeTripId(providedTripId ?? undefined);
    if (normalizedProvided) {
      if (this.pendingTerminal.isBlocked(entityId, normalizedProvided)) {
        return null;
      }
      return normalizedProvided;
    }

    const restored = await fetchActiveTrip();
    if (restored && this.pendingTerminal.isBlocked(entityId, restored)) {
      this.logger.warn(
        `[rejoin] Skipping restore for ${entityId} trip ${tripIdKey(restored)} — pending terminal attempt`,
      );
      return null;
    }

    return restored;
  }

  private clearDriverTripAssociation(
    driverId: string | number,
    previousTripId?: TripId | null,
  ): void {
    const tripToLeave =
      previousTripId ?? this.driverState.getActiveTripId(driverId);

    if (tripToLeave) {
      this.connectionManager.leaveDriverFromTripRoom(
        this.server,
        driverId,
        tripToLeave,
      );
    }

    this.tripParticipants.clearDriver(driverId);
    this.driverState.setOnline(driverId);
  }

  private clearUserTripAssociation(
    userId: string | number,
    tripId?: TripId | null,
  ): void {
    if (tripId) {
      this.connectionManager.leaveUserFromTripRoom(this.server, userId, tripId);
    }

    this.tripParticipants.clearUser(userId);
  }

  private emitDriverConnectionEvent(
    event:
      | typeof EVENTS.DRIVER_DISCONNECTED
      | typeof EVENTS.DRIVER_RECONNECTED,
    tripId: TripId,
    driverId: string | number,
  ): void {
    const payload = { tripId, driverId };

    this.tripEventEmitter.emitToTripRoom(
      this.server,
      tripId,
      event,
      payload,
      `driver-connection:${event}`,
      { driverId },
    );

    const participants = this.tripParticipants.get(tripId);
    if (participants?.userId) {
      this.tripEventEmitter.emitDirectToUser(
        this.server,
        participants.userId,
        event,
        payload,
        `driver-connection:${event}:fallback`,
      );
    }
  }

  private async handleRejectionCooldownExpired(
    driverId: string,
    tripId: TripId,
  ): Promise<void> {
    const status = await this.backendApi.fetchTripStatus(tripId);

    if (status !== TRIP_STATUS.REQUESTED) {
      this.logger.log(
        `[rejection-cooldown] Trip ${tripIdKey(tripId)} status is ${status ?? 'unknown'} — not re-adding for driver ${driverId}`,
      );
      return;
    }

    if (!this.driverState.canReceiveOffers(driverId)) {
      this.logger.log(
        `[rejection-cooldown] Driver ${driverId} cannot receive offers — skipping re-add for trip ${tripIdKey(tripId)}`,
      );
      return;
    }

    const added = this.driverQueue.addTripToDriver(driverId, tripId);
    if (added && !this.offerManager.hasOffer(driverId)) {
      this.offerManager.offerNextTrip(this.server, driverId);
      this.logger.log(
        `[rejection-cooldown] Trip ${tripIdKey(tripId)} re-queued for driver ${driverId} (status 1)`,
      );
    }
  }

  private syncUserTripState(
    client: Socket,
    userId: string | number,
    tripId: TripId,
  ) {
    this.logger.log(
      `[rejoin-sync] User ${userId} rejoined trip ${tripId} — checking cached state`,
    );

    const cachedAcceptance =
      this.acceptanceCache.get(tripId) ??
      this.reconstructAcceptanceFromActiveState(tripId);

    if (cachedAcceptance) {
      if (!this.acceptanceCache.get(tripId)) {
        this.acceptanceCache.set(cachedAcceptance);
      }
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

  private reconstructAcceptanceFromActiveState(tripId: TripId) {
    const participants = this.tripParticipants.get(tripId);
    const driverId =
      participants?.driverId ?? this.driverState.findDriverOnTrip(tripId);

    if (!driverId) {
      return null;
    }

    if (
      !this.driverState.isAssigneeForTrip(driverId, tripId) &&
      !participants?.driverId
    ) {
      return null;
    }

    const vehicleNo = this.driverState.getVehicleNo(driverId);
    return {
      tripId,
      driverId,
      ...(vehicleNo ? { vehicleNo } : {}),
    };
  }

  private clearAcceptanceCache(tripId: TripId): void {
    this.acceptanceCache.clear(tripId);
  }

  private resolveDriverId(
    client: Socket,
    payloadDriverId?: string | number,
  ): string | null {
    const socketDriverId = this.connectionManager.findDriverIdBySocket(
      client.id,
    );
    if (!socketDriverId) {
      return null;
    }
    if (
      payloadDriverId !== undefined &&
      String(payloadDriverId) !== String(socketDriverId)
    ) {
      return null;
    }
    return socketDriverId;
  }

  private resolveUserId(
    client: Socket,
    payloadUserId?: string | number,
  ): string | null {
    const socketUserId = this.connectionManager.findUserIdBySocket(client.id);
    if (!socketUserId) {
      return null;
    }
    if (
      payloadUserId !== undefined &&
      String(payloadUserId) !== String(socketUserId)
    ) {
      return null;
    }
    return socketUserId;
  }

  private cacheVehicleNo(
    driverId: string,
    vehicleNo?: string,
  ): string | undefined {
    if (vehicleNo) {
      this.driverState.setVehicleNo(driverId, vehicleNo);
    }
    return vehicleNo ?? this.driverState.getVehicleNo(driverId);
  }

  private resolveEventCoordinates(
    tripId: TripId,
    payload: DriverCoordinatePayload,
  ): DriverCoordinates | null {
    const fromPayload = resolveDriverCoordinates(payload);
    if (fromPayload) {
      return fromPayload;
    }

    const cached = this.locationCache.get(tripId);
    if (!cached) {
      return null;
    }

    return resolveDriverCoordinates({
      latitude: cached.latitude,
      longitude: cached.longitude,
    });
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
    const driverId = this.resolveDriverId(client);
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
    payload: {
      driverId: string | number;
      tripId?: string | number | null;
      skipTripRestore?: boolean;
    },
  ): Promise<SocketAck | void> {
    this.logger.log(
      `Received ${EVENTS.REGISTER_DRIVER} from socket ${client.id} with payload: ${JSON.stringify(payload)}`,
    );
    const { driverId, tripId, skipTripRestore } = payload;
    if (!driverId) {
      this.logger.warn('REGISTER_DRIVER called without driverId');
      return { ok: false, message: 'Driver not registered' };
    }

    const skipRestore = skipTripRestore === true;
    if (
      this.socketRegistration.isDuplicateDriverRegister(
        client.id,
        driverId,
        tripId,
        skipRestore,
      )
    ) {
      if (
        (tripId === null || tripId === undefined) &&
        this.driverState.isOnTrip(driverId)
      ) {
        this.clearDriverTripAssociation(driverId);
        this.logger.log(
          `[rejoin] Driver ${driverId} duplicate register cleared stale on_trip state`,
        );
      }
      return { ok: true, duplicate: true };
    }

    return this.withDriverRegisterLock(String(driverId), async () => {
      const previousTripId = this.driverState.getActiveTripId(driverId);
      const blockedTripId = normalizeTripId(tripId ?? undefined);

      if (
        blockedTripId &&
        this.pendingTerminal.isBlocked(driverId, blockedTripId)
      ) {
        this.socketRegistration.recordDriverRegister(
          client.id,
          driverId,
          tripId,
          skipRestore,
        );
        return {
          ok: false,
          retryComplete: true,
          tripId: blockedTripId,
          message: 'Recent trip completion failed — retry required',
        };
      }

      this.connectionManager.addDriver(driverId, client.id);
      this.connectionManager.joinDriverPersonalRoom(this.server, driverId, client);
      this.disconnectGrace.cancelDriverCleanup(driverId);

      if (this.driverState.isReconnecting(driverId)) {
        this.driverState.setOnline(driverId);
      }

      const activeTripId = await this.resolveRestoredTripId(
        driverId,
        tripId,
        skipRestore,
        () => this.backendApi.fetchDriverActiveTrip(driverId),
      );

      if (activeTripId) {
        this.connectionManager.joinSocketToTripRoom(client, activeTripId);
        this.driverState.setOnTrip(driverId, activeTripId);
        this.tripParticipants.setDriver(activeTripId, driverId);
        this.logger.log(
          `[rejoin] Driver ${driverId} joined active trip ${activeTripId} | ${this.tripEventEmitter.getRoomDebugInfo(this.server, activeTripId)}`,
        );

        if (
          this.disconnectTracker.shouldEmitDriverReconnected(
            driverId,
            client.id,
          )
        ) {
          this.disconnectTracker.clearDisconnectFlag(driverId);
          this.emitDriverConnectionEvent(
            EVENTS.DRIVER_RECONNECTED,
            activeTripId,
            driverId,
          );
        }
      } else {
        this.clearDriverTripAssociation(driverId, previousTripId);
        this.logger.log(`[rejoin] Driver ${driverId} registered (no active trip)`);
      }

      this.socketRegistration.recordDriverRegister(
        client.id,
        driverId,
        tripId,
        skipRestore,
      );

      if (this.driverState.canReceiveOffers(driverId)) {
        await this.offerManager.recoverPendingOffersOnRegister(
          this.server,
          driverId,
          client.id,
        );
      } else {
        this.logger.log(
          `[rejoin] Driver ${driverId} on active trip — skipping offer flow`,
        );
      }

      return { ok: true };
    });
  }

  @SubscribeMessage(EVENTS.REGISTER_USER)
  async handleRegisterUser(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: {
      userId: string | number;
      tripId?: string | number | null;
      skipTripRestore?: boolean;
    },
  ): Promise<SocketAck | void> {
    this.logger.log(
      `Received ${EVENTS.REGISTER_USER} from socket ${client.id} with payload: ${JSON.stringify(payload)}`,
    );
    const { userId, tripId, skipTripRestore } = payload;
    if (!userId) {
      this.logger.warn('REGISTER_USER called without userId');
      return { ok: false, message: 'User not registered' };
    }

    const skipRestore = skipTripRestore === true;
    if (
      this.socketRegistration.isDuplicateUserRegister(
        client.id,
        userId,
        tripId,
        skipRestore,
      )
    ) {
      return { ok: true, duplicate: true };
    }

    this.connectionManager.addUser(userId, client.id);

    const activeTripId = await this.resolveRestoredTripId(
      userId,
      tripId,
      skipRestore,
      () => this.backendApi.fetchUserActiveTrip(userId),
    );

    if (activeTripId) {
      this.connectionManager.joinSocketToTripRoom(client, activeTripId);
      this.logger.log(
        `[rejoin] User ${userId} joined trip room ${activeTripId} | ${this.tripEventEmitter.getRoomDebugInfo(this.server, activeTripId)}`,
      );
      this.tripParticipants.setUser(activeTripId, userId);
      this.syncUserTripState(client, userId, activeTripId);
    } else {
      this.clearUserTripAssociation(userId, normalizeTripId(tripId));
      this.logger.log(`[rejoin] User ${userId} registered (no active trip)`);
    }

    this.socketRegistration.recordUserRegister(
      client.id,
      userId,
      tripId,
      skipRestore,
    );

    return { ok: true };
  }

  @SubscribeMessage(EVENTS.TRIP_ACCEPTED)
  async handleAcceptOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: {
      tripId: number | string;
      driverId?: string | number;
      vehicleNo?: string;
    },
  ): Promise<SocketAck> {
    this.logger.log(`Received ${EVENTS.TRIP_ACCEPTED} from socket ${client.id} with payload: ${JSON.stringify(payload)}`);
    const normalizedTripId = normalizeTripId(payload?.tripId);
    const driverId = this.resolveDriverId(client, payload?.driverId);

    if (!driverId) {
      this.logger.warn('TRIP_ACCEPTED from unregistered or mismatched driver socket');
      return { ok: false, message: 'Driver not registered' };
    }

    if (!normalizedTripId) {
      this.logger.warn('TRIP_ACCEPTED called with invalid tripId');
      return { ok: false, message: 'Invalid tripId' };
    }

    const result = this.offerManager.handleAccept(driverId, normalizedTripId);
    if (!result.valid) {
      this.offerManager.clearOffer(driverId);
      this.offerManager.offerNextTrip(this.server, driverId);
      return { ok: false, message: 'No valid offer for this trip' };
    }

    try {
      const vehicleNo = this.cacheVehicleNo(driverId, payload.vehicleNo);
      const acceptPayload = {
        tripId: normalizedTripId,
        driverId,
        ...(vehicleNo && { vehicleNo }),
      };

      const acceptResult = await this.tripLifecycle.processAcceptLifecycle(
        this.server,
        client,
        {
          tripId: normalizedTripId,
          driverId,
          vehicleNo,
          broadcastPayload: acceptPayload,
          context: 'socket-accept',
        },
      );

      if (!acceptResult.ok) {
        this.driverQueue.removeTripFromDriver(driverId, normalizedTripId);
        if (this.driverState.canReceiveOffers(driverId)) {
          this.offerManager.offerNextTrip(this.server, driverId);
        }
        return acceptResult;
      }

      if (acceptResult.duplicate) {
        return acceptResult;
      }

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

      this.tripEventEmitter.emitAcceptedByOtherDrivers(
        this.server,
        normalizedTripId,
        driverId,
        'socket-accept',
      );

      this.offerManager.clearAllOffersForTrip(
        this.server,
        normalizedTripId,
        driverId,
      );

      this.pendingTerminal.clearAttempt(driverId, normalizedTripId);

      this.logger.log(
        `[accept] Trip ${normalizedTripId} acceptance complete | ${this.tripEventEmitter.getRoomDebugInfo(this.server, normalizedTripId)}`,
      );

      return acceptResult;
    } catch (err) {
      this.logger.error(
        `Failed to accept trip ${normalizedTripId}: ${(err as Error).message}`,
      );
      this.driverQueue.removeTripFromDriver(driverId, normalizedTripId);
      this.offerManager.offerNextTrip(this.server, driverId);
      return { ok: false, message: 'Internal error processing acceptance' };
    }
  }

  @SubscribeMessage(EVENTS.TRIP_STARTED)
  async handleTripStarted(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TripStartedSocketDto,
  ): Promise<SocketAck> {
    this.logger.log(
      `Received ${EVENTS.TRIP_STARTED} from socket ${client.id} with payload: ${JSON.stringify(payload)}`,
    );

    const tripId = normalizeTripId(payload?.tripId);
    const driverId = this.resolveDriverId(client, payload?.driverId);

    if (!driverId) {
      return { ok: false, message: 'Driver not registered' };
    }
    if (!tripId) {
      return { ok: false, message: 'Invalid tripId' };
    }

    const coordinates = this.resolveEventCoordinates(tripId, payload);
    if (!coordinates) {
      return { ok: false, message: 'Invalid coordinates' };
    }

    const vehicleNo = this.cacheVehicleNo(driverId, payload.vehicleNo);

    return this.tripLifecycle.processDriverLifecycle(this.server, client, {
      event: EVENTS.TRIP_STARTED,
      status: TRIP_STATUS.STARTED,
      tripId,
      driverId,
      vehicleNo,
      lat: coordinates.lat,
      lng: coordinates.lng,
      broadcastPayload: {
        tripId,
        driverId,
        lat: coordinates.lat,
        lng: coordinates.lng,
        ...(vehicleNo && { vehicleNo }),
      },
      context: 'socket-started',
    });
  }

  @SubscribeMessage(EVENTS.TRIP_COMPLETED)
  async handleTripCompleted(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TripCompletedSocketDto,
  ): Promise<SocketAck> {
    this.logger.log(
      `Received ${EVENTS.TRIP_COMPLETED} from socket ${client.id} with payload: ${JSON.stringify(payload)}`,
    );

    const tripId = normalizeTripId(payload?.tripId);
    const driverId = this.resolveDriverId(client, payload?.driverId);

    if (!driverId) {
      return { ok: false, message: 'Driver not registered' };
    }
    if (!tripId) {
      return { ok: false, message: 'Invalid tripId' };
    }

    const coordinates = this.resolveEventCoordinates(tripId, payload);
    if (!coordinates) {
      return { ok: false, message: 'Invalid coordinates' };
    }

    const vehicleNo = this.cacheVehicleNo(driverId, payload.vehicleNo);

    const result = await this.tripLifecycle.processDriverLifecycle(
      this.server,
      client,
      {
        event: EVENTS.TRIP_COMPLETED,
        status: TRIP_STATUS.COMPLETED,
        tripId,
        driverId,
        vehicleNo,
        lat: coordinates.lat,
        lng: coordinates.lng,
        driversFeedback: payload.driversFeedback,
        usersRating: payload.feedbackUsersRating,
        broadcastPayload: {
          tripId,
          driverId,
          lat: coordinates.lat,
          lng: coordinates.lng,
          ...(vehicleNo && { vehicleNo }),
          ...(payload.driversFeedback !== undefined && {
            driversFeedback: payload.driversFeedback,
          }),
          ...(payload.feedbackUsersRating !== undefined && {
            feedbackUsersRating: payload.feedbackUsersRating,
          }),
        },
        context: 'socket-completed',
        terminal: true,
      },
    );

    if (result.ok) {
      this.clearAcceptanceCache(tripId);
    }

    return result;
  }

  @SubscribeMessage(EVENTS.TRIP_CANCELLED_BY_DRIVER)
  async handleTripCancelledByDriver(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: {
      tripId: number | string;
      driverId?: string | number;
      vehicleNo?: string;
      driversFeedback?: string;
      reason?: string;
    },
  ): Promise<SocketAck> {
    this.logger.log(
      `Received ${EVENTS.TRIP_CANCELLED_BY_DRIVER} from socket ${client.id} with payload: ${JSON.stringify(payload)}`,
    );

    const tripId = normalizeTripId(payload?.tripId);
    const driverId = this.resolveDriverId(client, payload?.driverId);

    if (!driverId) {
      return { ok: false, message: 'Driver not registered' };
    }
    if (!tripId) {
      return { ok: false, message: 'Invalid tripId' };
    }

    const vehicleNo = this.cacheVehicleNo(driverId, payload.vehicleNo);
    const driversFeedback = payload.driversFeedback ?? payload.reason;

    const result = await this.tripLifecycle.processDriverLifecycle(
      this.server,
      client,
      {
        event: EVENTS.TRIP_CANCELLED_BY_DRIVER,
        status: TRIP_STATUS.CANCELLED_BY_DRIVER,
        tripId,
        driverId,
        vehicleNo,
        driversFeedback,
        reason: payload.reason,
        broadcastPayload: {
          tripId,
          driverId,
          ...(driversFeedback !== undefined && { reason: driversFeedback }),
          ...(vehicleNo && { vehicleNo }),
        },
        context: 'socket-cancelled-by-driver',
        terminal: true,
        clearOffers: true,
      },
    );

    if (result.ok) {
      this.clearAcceptanceCache(tripId);
    }

    return result;
  }

  @SubscribeMessage(EVENTS.TRIP_REJECTED)
  handleRejectOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: {
      tripId: number | string;
      driverId?: string | number;
      reason?: string;
    },
  ): SocketAck {
    this.logger.log(
      `Received ${EVENTS.TRIP_REJECTED} from socket ${client.id} with payload: ${JSON.stringify(payload)}`,
    );
    const normalizedTripId = normalizeTripId(payload?.tripId);
    const driverId = this.resolveDriverId(client, payload?.driverId);

    if (!driverId) {
      this.logger.warn('TRIP_REJECTED from unknown socket');
      return { ok: false, message: 'Driver not registered' };
    }

    if (!normalizedTripId) {
      this.logger.warn('TRIP_REJECTED called with invalid tripId');
      return { ok: false, message: 'Invalid tripId' };
    }

    if (this.shouldIgnoreRejection(driverId, normalizedTripId)) {
      this.logger.log(
        `[reject] Ignoring TRIP_REJECTED from driver ${driverId} for trip ${normalizedTripId} — trip already accepted / past offer stage`,
      );
      return { ok: true, duplicate: true };
    }

    this.rejectionCooldown.recordRejection(
      driverId,
      normalizedTripId,
      payload.reason,
    );
    this.driverQueue.removeTripFromDriver(driverId, normalizedTripId);

    const offer = this.offerManager.getOffer(driverId);
    if (offer && tripIdsEqual(offer.tripId, normalizedTripId)) {
      this.offerManager.handleReject(this.server, driverId);
    } else if (this.driverState.canReceiveOffers(driverId)) {
      this.offerManager.offerNextTrip(this.server, driverId);
    }

    return { ok: true };
  }

  private shouldIgnoreRejection(
    driverId: string | number,
    tripId: TripId,
  ): boolean {
    if (this.driverState.isAssigneeForTrip(driverId, tripId)) {
      return true;
    }

    if (this.driverState.isOnTrip(driverId)) {
      return true;
    }

    const acceptance = this.acceptanceCache.get(tripId);
    if (acceptance && String(acceptance.driverId) === String(driverId)) {
      return true;
    }

    const participants = this.tripParticipants.get(tripId);
    if (
      participants?.driverId &&
      String(participants.driverId) === String(driverId)
    ) {
      return true;
    }

    return false;
  }

  @SubscribeMessage(EVENTS.TRIP_CANCELLED_BY_USER)
  async handleTripCancelledByUser(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: {
      tripId: number | string;
      userId?: string | number;
      reason?: string;
      tag?: string;
    },
  ): Promise<SocketAck> {
    this.logger.log(
      `Received ${EVENTS.TRIP_CANCELLED_BY_USER} from socket ${client.id} with payload: ${JSON.stringify(payload)}`,
    );

    const tripId = normalizeTripId(payload?.tripId);
    const userId = this.resolveUserId(client, payload?.userId);

    if (!userId) {
      return { ok: false, message: 'User not registered' };
    }
    if (!tripId) {
      return { ok: false, message: 'Invalid tripId' };
    }

    const result = await this.tripLifecycle.processUserLifecycle(
      this.server,
      client,
      {
        event: EVENTS.TRIP_CANCELLED_BY_USER,
        status: TRIP_STATUS.CANCELLED_BY_USER,
        tripId,
        userId,
        reason: payload.reason,
        broadcastPayload: {
          tripId,
          userId,
          ...(payload.reason !== undefined && { reason: payload.reason }),
          ...(payload.tag !== undefined && { tag: payload.tag }),
        },
        context: 'socket-cancelled-by-user',
      },
    );

    if (result.ok) {
      this.clearAcceptanceCache(tripId);
    }

    return result;
  }
}
