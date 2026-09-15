import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { ConnectionManagerService } from './connection-manager.service';
import { TripParticipantsService } from './trip-participants.service';
import { DriverQueueService } from './driver-queue.service';
import { EVENTS } from '../../config/events.constant';
import { TripId, tripIdKey } from '../utils/trip-id.util';

@Injectable()
export class TripEventEmitterService {
  private readonly logger = new Logger(TripEventEmitterService.name);

  constructor(
    private readonly connectionManager: ConnectionManagerService,
    private readonly tripParticipants: TripParticipantsService,
    private readonly driverQueue: DriverQueueService,
  ) {}

  getRoomDebugInfo(io: Server, tripId: TripId): string {
    const room = this.connectionManager.tripRoom(tripId);
    const roomSockets = io.sockets.adapter.rooms.get(room);
    const socketCount = roomSockets?.size ?? 0;
    const participants = this.tripParticipants.get(tripId);

    const onlineDriver = participants?.driverId
      ? this.connectionManager.getDriverSocketId(participants.driverId)
      : null;
    const onlineUser = participants?.userId
      ? this.connectionManager.getUserSocketId(participants.userId)
      : null;

    return (
      `room=${room}, sockets=${socketCount}, ` +
      `userId=${participants?.userId ?? 'unknown'} (online=${onlineUser ? 'yes' : 'no'}), ` +
      `driverId=${participants?.driverId ?? 'unknown'} (online=${onlineDriver ? 'yes' : 'no'})`
    );
  }

  ensureParticipantsInRoom(
    io: Server,
    tripId: TripId,
    driverId?: string | number,
    userId?: string | number,
  ): void {
    const participants = this.tripParticipants.get(tripId);
    const resolvedDriverId = driverId ?? participants?.driverId;
    const resolvedUserId = userId ?? participants?.userId;

    if (resolvedDriverId) {
      this.connectionManager.joinDriverToTripRoom(
        io,
        resolvedDriverId,
        tripId,
      );
    }

    if (resolvedUserId) {
      this.connectionManager.joinUserToTripRoom(io, resolvedUserId, tripId);
    }
  }

  emitToTripRoom(
    io: Server,
    tripId: TripId,
    event: string,
    payload: Record<string, unknown>,
    context: string,
    options?: { driverId?: string | number; userId?: string | number },
  ): void {
    this.ensureParticipantsInRoom(
      io,
      tripId,
      options?.driverId,
      options?.userId,
    );

    const room = this.connectionManager.tripRoom(tripId);
    const roomSockets = io.sockets.adapter.rooms.get(room);
    const socketCount = roomSockets?.size ?? 0;

    this.logger.log(
      `[${context}] Emitting ${event} → ${this.getRoomDebugInfo(io, tripId)} | payload=${JSON.stringify(payload)}`,
    );

    if (socketCount === 0) {
      this.logger.warn(
        `[${context}] ${event} for trip ${tripIdKey(tripId)} — no sockets in room; event may not be delivered`,
      );
    }

    io.to(room).emit(event, payload);
  }

  emitDirectToUser(
    io: Server,
    userId: string | number,
    event: string,
    payload: Record<string, unknown>,
    context: string,
  ): void {
    const socketId = this.connectionManager.getUserSocketId(userId);
    if (!socketId) {
      this.logger.warn(
        `[${context}] Cannot direct-emit ${event} to user ${userId} — offline`,
      );
      return;
    }

    this.logger.log(
      `[${context}] Direct-emit ${event} → user ${userId} (socket ${socketId}) | payload=${JSON.stringify(payload)}`,
    );
    io.to(socketId).emit(event, payload);
  }

  emitDirectToDriver(
    io: Server,
    driverId: string | number,
    event: string,
    payload: Record<string, unknown>,
    context: string,
  ): void {
    const socketId = this.connectionManager.getDriverSocketId(driverId);
    if (!socketId) {
      this.logger.warn(
        `[${context}] Cannot direct-emit ${event} to driver ${driverId} — offline`,
      );
      return;
    }

    this.logger.log(
      `[${context}] Direct-emit ${event} → driver ${driverId} (socket ${socketId}) | payload=${JSON.stringify(payload)}`,
    );
    io.to(socketId).emit(event, payload);
  }

  /**
   * Drivers currently associated with a trip's active offer pool.
   * The pool is the driver queue — offered drivers only join the trip room
   * once they accept, so the Socket.IO room can never be used for this.
   */
  getTripPoolDriverIds(
    tripId: TripId,
    extraDriverIds?: (string | number)[],
  ): string[] {
    const pool = new Set(this.driverQueue.getDriversWithTrip(tripId));
    for (const driverId of extraDriverIds ?? []) {
      pool.add(String(driverId));
    }
    return [...pool];
  }

  /** Targeted emission to the trip's pool drivers only — never a global broadcast. */
  emitToPoolDrivers(
    io: Server,
    tripId: TripId,
    event: string,
    payload: Record<string, unknown>,
    context: string,
    options?: {
      poolDriverIds?: (string | number)[];
      excludeDriverIds?: (string | number)[];
    },
  ): string[] {
    const excluded = new Set(
      (options?.excludeDriverIds ?? []).map((id) => String(id)),
    );
    const pool = this.getTripPoolDriverIds(tripId, options?.poolDriverIds).filter(
      (driverId) => !excluded.has(driverId),
    );

    this.logger.log(
      `[${context}] Emitting ${event} → pool drivers for trip ${tripIdKey(tripId)}: [${pool.join(', ') || 'none'}]`,
    );

    for (const driverId of pool) {
      this.emitDirectToDriver(io, driverId, event, payload, context);
    }

    return pool;
  }

  isUserInTripRoom(
    io: Server,
    tripId: TripId,
    userId: string | number,
  ): boolean {
    const socketId = this.connectionManager.getUserSocketId(userId);
    if (!socketId) {
      return false;
    }
    const room = this.connectionManager.tripRoom(tripId);
    return io.sockets.adapter.rooms.get(room)?.has(socketId) ?? false;
  }

  /** Resolves the driver that currently owns the trip, if it has been accepted. */
  private resolveAssigneeDriverId(
    tripId: TripId,
    driverId?: string | number,
  ): string | number | undefined {
    return driverId ?? this.tripParticipants.get(tripId)?.driverId;
  }

  /**
   * Sent to the other drivers that still hold this trip in their offer pool.
   * Never delivered to the user, and never to unrelated drivers.
   */
  emitAcceptedByOtherDrivers(
    io: Server,
    tripId: TripId,
    assigneeDriverId: string | number,
    context: string,
    options?: { poolDriverIds?: (string | number)[] },
  ): void {
    const payload = {
      tripId,
      driverId: assigneeDriverId,
      message: 'Trip accepted by another driver.',
    };

    this.logger.log(
      `[TripEvent]\n\nEmitting ${EVENTS.TRIP_ACCEPTED_BY_OTHER_DRIVER}\n\nTrip:\n${tripIdKey(tripId)}\n\nAssignee driver:\n${assigneeDriverId}`,
    );

    this.emitToPoolDrivers(
      io,
      tripId,
      EVENTS.TRIP_ACCEPTED_BY_OTHER_DRIVER,
      payload,
      context,
      {
        poolDriverIds: options?.poolDriverIds,
        excludeDriverIds: [assigneeDriverId],
      },
    );
  }

  /**
   * Before acceptance: user + every driver holding the offer.
   * After acceptance: user + accepted driver only (the trip room already is
   * exactly those two sockets), so pool drivers are not notified.
   */
  emitTripCancelledByUser(
    io: Server,
    tripId: TripId,
    payload: Record<string, unknown>,
    context: string,
    options?: {
      driverId?: string | number;
      userId?: string | number;
      poolDriverIds?: (string | number)[];
    },
  ): void {
    const enriched = {
      message: 'Trip cancelled by user.',
      ...payload,
      tripId,
    };

    const assigneeDriverId = this.resolveAssigneeDriverId(
      tripId,
      options?.driverId,
    );

    this.logger.log(
      `[TripEvent]\n\nEmitting ${EVENTS.TRIP_CANCELLED_BY_USER}\n\nTrip:\n${tripIdKey(tripId)}\n\n` +
        `Phase: ${assigneeDriverId ? `accepted (driver ${assigneeDriverId})` : 'searching'}\n\n` +
        `Payload:\n${JSON.stringify(enriched)}`,
    );

    this.emitToTripRoom(
      io,
      tripId,
      EVENTS.TRIP_CANCELLED_BY_USER,
      enriched,
      context,
      { driverId: assigneeDriverId, userId: options?.userId },
    );

    if (assigneeDriverId) {
      return;
    }

    this.emitToPoolDrivers(
      io,
      tripId,
      EVENTS.TRIP_CANCELLED_BY_USER,
      enriched,
      context,
      { poolDriverIds: options?.poolDriverIds },
    );
  }
}
