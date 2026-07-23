import { Injectable, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { TRIP_STATUS } from '../../config/app.config';
import { ConnectionManagerService } from './connection-manager.service';
import { TripParticipantsService } from './trip-participants.service';
import { LocationCacheService } from './location-cache.service';
import { OfferManagerService } from './offer-manager.service';
import { TripEventEmitterService } from './trip-event-emitter.service';
import { BackendApiService } from './backend-api.service';
import { DriverStateService } from './driver-state.service';
import { TripLifecycleLockService } from './trip-lifecycle-lock.service';
import { PendingTerminalService } from './pending-terminal.service';
import { DriverDisconnectTrackerService } from './driver-disconnect-tracker.service';
import { TripAcceptanceCacheService } from './trip-acceptance-cache.service';
import { TripRejectionCooldownService } from './trip-rejection-cooldown.service';
import { TripRequestTimeoutService } from './trip-request-timeout.service';
import { EVENTS } from '../../config/events.constant';
import { TripId } from '../utils/trip-id.util';

export interface SocketAck {
  ok: boolean;
  message?: string;
  duplicate?: boolean;
  retryComplete?: boolean;
  tripId?: TripId;
}

@Injectable()
export class TripLifecycleService {
  private readonly logger = new Logger(TripLifecycleService.name);

  constructor(
    private readonly connectionManager: ConnectionManagerService,
    private readonly tripParticipants: TripParticipantsService,
    private readonly locationCache: LocationCacheService,
    private readonly offerManager: OfferManagerService,
    private readonly tripEventEmitter: TripEventEmitterService,
    private readonly backendApi: BackendApiService,
    private readonly driverState: DriverStateService,
    private readonly lifecycleLock: TripLifecycleLockService,
    private readonly pendingTerminal: PendingTerminalService,
    private readonly disconnectTracker: DriverDisconnectTrackerService,
    private readonly acceptanceCache: TripAcceptanceCacheService,
    private readonly rejectionCooldown: TripRejectionCooldownService,
    private readonly tripRequestTimeout: TripRequestTimeoutService,
  ) {}

  private rejectIfTerminal(tripId: TripId, context: string): SocketAck | null {
    if (!this.tripRequestTimeout.isTerminal(tripId)) {
      return null;
    }
    this.logger.log(
      `[${context}] Trip ${tripId} is terminal (status 8) — ignoring lifecycle event`,
    );
    return { ok: true, duplicate: true, tripId };
  }

  validateDriverTripRoom(
    client: Socket,
    tripId: TripId,
    driverId: string,
  ): SocketAck | null {
    const room = this.connectionManager.tripRoom(tripId);
    if (!client.rooms.has(room)) {
      return { ok: false, message: 'Driver not in trip room' };
    }

    const participants = this.tripParticipants.get(tripId);
    if (
      participants?.driverId &&
      String(participants.driverId) !== String(driverId)
    ) {
      return { ok: false, message: 'Driver not assigned to this trip' };
    }

    return null;
  }

  validateUserTripRoom(
    client: Socket,
    tripId: TripId,
    userId: string | number,
  ): SocketAck | null {
    const room = this.connectionManager.tripRoom(tripId);
    if (!client.rooms.has(room)) {
      return { ok: false, message: 'User not in trip room' };
    }

    const participants = this.tripParticipants.get(tripId);
    if (
      participants?.userId &&
      String(participants.userId) !== String(userId)
    ) {
      return { ok: false, message: 'User not assigned to this trip' };
    }

    return null;
  }

  cleanupTerminalTrip(io: Server, tripId: TripId): void {
    this.locationCache.clear(tripId);
    this.tripParticipants.clear(tripId);
    this.connectionManager.leaveTripRoom(io, tripId);
  }

  /**
   * Releases the assignee driver and clears all in-memory trip state.
   * Resolves the driver from trip participants when not supplied explicitly.
   */
  private finalizeTerminalTrip(
    io: Server,
    tripId: TripId,
    driverId?: string | number,
  ): void {
    const assigneeDriverId =
      driverId ??
      this.tripParticipants.get(tripId)?.driverId ??
      this.driverState.findDriverOnTrip(tripId) ??
      undefined;

    if (assigneeDriverId) {
      this.driverState.setOnline(assigneeDriverId);
      this.disconnectTracker.clearDisconnectFlag(assigneeDriverId);
    }

    this.rejectionCooldown.clearAllForTrip(tripId);
    this.acceptanceCache.clear(tripId);
    this.cleanupTerminalTrip(io, tripId);
  }

  private async isStatusAlreadyApplied(
    tripId: TripId,
    targetStatus: number,
  ): Promise<boolean> {
    const currentStatus = await this.backendApi.fetchTripStatus(tripId);
    if (currentStatus === null) {
      return false;
    }

    return currentStatus >= targetStatus;
  }

  async processDriverLifecycle(
    io: Server,
    client: Socket,
    params: {
      event: string;
      status: number;
      tripId: TripId;
      driverId: string;
      broadcastPayload: Record<string, unknown>;
      context: string;
      terminal?: boolean;
      clearOffers?: boolean;
      reason?: string;
      vehicleNo?: string;
      driversFeedback?: string;
      usersRating?: number;
      lat?: string;
      lng?: string;
    },
  ): Promise<SocketAck> {
    const terminal = this.rejectIfTerminal(params.tripId, params.context);
    if (terminal) {
      return terminal;
    }

    const roomError = this.validateDriverTripRoom(
      client,
      params.tripId,
      params.driverId,
    );
    if (roomError) {
      this.logger.warn(
        `[${params.context}] Validation failed for driver ${params.driverId} trip ${params.tripId}: ${roomError.message}`,
      );
      return roomError;
    }

    if (!this.lifecycleLock.tryAcquire(params.tripId)) {
      return { ok: false, message: 'Processing' };
    }

    try {
      if (await this.isStatusAlreadyApplied(params.tripId, params.status)) {
        this.logger.log(
          `[${params.context}] ${params.event} ignored trip ${params.tripId} — status already >= ${params.status}`,
        );
        return { ok: true, duplicate: true, tripId: params.tripId };
      }

      this.logger.log(
        `[${params.context}] PATCH status ${params.status} for trip ${params.tripId} driver ${params.driverId}`,
      );

      const updated = await this.backendApi.updateTripStatus({
        tripId: params.tripId,
        status: params.status,
        driverId: params.driverId,
        reason: params.reason,
        vehicleNo:
          params.vehicleNo ?? this.driverState.getVehicleNo(params.driverId),
        driversFeedback: params.driversFeedback,
        usersRating: params.usersRating,
        lat: params.lat,
        lng: params.lng,
      });

      if (!updated) {
        if (params.terminal) {
          this.pendingTerminal.recordAttempt(
            params.driverId,
            params.tripId,
            params.status,
          );
        }

        this.logger.warn(
          `[${params.context}] Backend rejected status ${params.status} for trip ${params.tripId} — ${params.event} will NOT be broadcast`,
        );

        return {
          ok: false,
          message: 'Backend rejected status update',
          retryComplete: params.terminal === true,
          tripId: params.tripId,
        };
      }

      this.pendingTerminal.clearAttempt(params.driverId, params.tripId);
      this.disconnectTracker.clearDisconnectFlag(params.driverId);
      this.tripParticipants.setDriver(params.tripId, params.driverId);

      this.tripEventEmitter.emitToTripRoom(
        io,
        params.tripId,
        params.event,
        params.broadcastPayload,
        params.context,
        { driverId: params.driverId },
      );

      if (params.clearOffers) {
        this.offerManager.clearAllOffersForTrip(
          io,
          params.tripId,
          params.driverId,
        );
      }

      if (params.terminal) {
        this.finalizeTerminalTrip(io, params.tripId, params.driverId);
        this.logger.log(
          `[${params.context}] Terminal cleanup complete for trip ${params.tripId}`,
        );
      }

      this.logger.log(
        `[${params.context}] ${params.event} complete | ${this.tripEventEmitter.getRoomDebugInfo(io, params.tripId)}`,
      );

      return { ok: true, tripId: params.tripId };
    } finally {
      this.lifecycleLock.release(params.tripId);
    }
  }

  async processAcceptLifecycle(
    io: Server,
    client: Socket,
    params: {
      tripId: TripId;
      driverId: string;
      vehicleNo?: string;
      broadcastPayload: Record<string, unknown>;
      context: string;
    },
  ): Promise<SocketAck> {
    const terminal = this.rejectIfTerminal(params.tripId, params.context);
    if (terminal) {
      return terminal;
    }

    if (!this.lifecycleLock.tryAcquire(params.tripId)) {
      return { ok: false, message: 'Processing' };
    }

    try {
      if (await this.isStatusAlreadyApplied(params.tripId, TRIP_STATUS.ACCEPTED)) {
        this.logger.log(
          `[${params.context}] TRIP_ACCEPTED ignored trip ${params.tripId} — already accepted`,
        );
        this.acceptanceCache.set({
          tripId: params.tripId,
          driverId: params.driverId,
          vehicleNo: params.vehicleNo,
        });
        return { ok: true, duplicate: true, tripId: params.tripId };
      }

      const updated = await this.backendApi.updateTripStatus({
        tripId: params.tripId,
        status: TRIP_STATUS.ACCEPTED,
        driverId: params.driverId,
        vehicleNo: params.vehicleNo,
      });

      if (!updated) {
        return { ok: false, message: 'Backend rejected status update' };
      }

      this.pendingTerminal.clearAttempt(params.driverId, params.tripId);
      this.disconnectTracker.clearDisconnectFlag(params.driverId);
      this.driverState.setOnTrip(params.driverId, params.tripId, params.vehicleNo);
      this.connectionManager.joinSocketToTripRoom(client, params.tripId);
      this.tripParticipants.setDriver(params.tripId, params.driverId);
      this.rejectionCooldown.clearAllForTrip(params.tripId);
      this.acceptanceCache.set({
        tripId: params.tripId,
        driverId: params.driverId,
        vehicleNo: params.vehicleNo,
      });

      this.tripEventEmitter.emitToTripRoom(
        io,
        params.tripId,
        EVENTS.TRIP_ACCEPTED,
        params.broadcastPayload,
        params.context,
        { driverId: params.driverId },
      );

      return { ok: true, tripId: params.tripId };
    } finally {
      this.lifecycleLock.release(params.tripId);
    }
  }

  async processUserLifecycle(
    io: Server,
    client: Socket,
    params: {
      event: string;
      status: number;
      tripId: TripId;
      userId: string | number;
      broadcastPayload: Record<string, unknown>;
      context: string;
      reason?: string;
    },
  ): Promise<SocketAck> {
    const terminal = this.rejectIfTerminal(params.tripId, params.context);
    if (terminal) {
      return terminal;
    }

    const roomError = this.validateUserTripRoom(
      client,
      params.tripId,
      params.userId,
    );
    if (roomError) {
      this.logger.warn(
        `[${params.context}] Validation failed for user ${params.userId} trip ${params.tripId}: ${roomError.message}`,
      );
      return roomError;
    }

    if (!this.lifecycleLock.tryAcquire(params.tripId)) {
      return { ok: false, message: 'Processing' };
    }

    try {
      if (await this.isStatusAlreadyApplied(params.tripId, params.status)) {
        this.logger.log(
          `[${params.context}] ${params.event} ignored trip ${params.tripId} — status already >= ${params.status}`,
        );
        return { ok: true, duplicate: true, tripId: params.tripId };
      }

      this.logger.log(
        `[${params.context}] PATCH status ${params.status} for trip ${params.tripId} user ${params.userId}`,
      );

      const updated = await this.backendApi.updateTripStatus({
        tripId: params.tripId,
        status: params.status,
        userId: params.userId,
        reason: params.reason,
      });

      if (!updated) {
        this.logger.warn(
          `[${params.context}] Backend rejected status ${params.status} for trip ${params.tripId} — ${params.event} will NOT be broadcast`,
        );
        return { ok: false, message: 'Backend rejected status update' };
      }

      this.tripParticipants.setUser(params.tripId, params.userId);

      const assigneeDriverId =
        this.tripParticipants.get(params.tripId)?.driverId ??
        this.driverState.findDriverOnTrip(params.tripId) ??
        undefined;

      if (params.event === EVENTS.TRIP_CANCELLED_BY_USER) {
        this.tripEventEmitter.emitTripCancelledByUser(
          io,
          params.tripId,
          params.broadcastPayload,
          params.context,
          { userId: params.userId, driverId: assigneeDriverId },
        );
      } else {
        this.tripEventEmitter.emitToTripRoom(
          io,
          params.tripId,
          params.event,
          params.broadcastPayload,
          params.context,
          { userId: params.userId, driverId: assigneeDriverId },
        );
      }

      this.offerManager.clearAllOffersForTrip(
        io,
        params.tripId,
        assigneeDriverId,
      );
      this.finalizeTerminalTrip(io, params.tripId, assigneeDriverId);

      this.logger.log(
        `[${params.context}] ${params.event} complete | ${this.tripEventEmitter.getRoomDebugInfo(io, params.tripId)}`,
      );

      return { ok: true, tripId: params.tripId };
    } finally {
      this.lifecycleLock.release(params.tripId);
    }
  }
}
