import { Injectable, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { ConnectionManagerService } from './connection-manager.service';
import { TripParticipantsService } from './trip-participants.service';
import { LocationCacheService } from './location-cache.service';
import { OfferManagerService } from './offer-manager.service';
import { TripEventEmitterService } from './trip-event-emitter.service';
import { BackendApiService } from './backend-api.service';
import { TripId } from '../utils/trip-id.util';

export interface SocketAck {
  ok: boolean;
  message?: string;
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
  ) {}

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
    },
  ): Promise<SocketAck> {
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

    this.logger.log(
      `[${params.context}] PATCH status ${params.status} for trip ${params.tripId} driver ${params.driverId}`,
    );

    const updated = await this.backendApi.updateTripStatus({
      tripId: params.tripId,
      status: params.status,
      driverId: params.driverId,
      reason: params.reason,
    });

    if (!updated) {
      this.logger.warn(
        `[${params.context}] Backend rejected status ${params.status} for trip ${params.tripId} — ${params.event} will NOT be broadcast`,
      );
      return { ok: false, message: 'Backend rejected status update' };
    }

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
      this.offerManager.clearAllOffersForTrip(io, params.tripId);
    }

    if (params.terminal) {
      this.cleanupTerminalTrip(io, params.tripId);
      this.logger.log(
        `[${params.context}] Terminal cleanup complete for trip ${params.tripId}`,
      );
    }

    this.logger.log(
      `[${params.context}] ${params.event} complete | ${this.tripEventEmitter.getRoomDebugInfo(io, params.tripId)}`,
    );

    return { ok: true };
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

    this.tripEventEmitter.emitToTripRoom(
      io,
      params.tripId,
      params.event,
      params.broadcastPayload,
      params.context,
      { userId: params.userId },
    );

    this.offerManager.clearAllOffersForTrip(io, params.tripId);
    this.cleanupTerminalTrip(io, params.tripId);

    this.logger.log(
      `[${params.context}] ${params.event} complete | ${this.tripEventEmitter.getRoomDebugInfo(io, params.tripId)}`,
    );

    return { ok: true };
  }
}
