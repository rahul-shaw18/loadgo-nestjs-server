import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { ConnectionManagerService } from './connection-manager.service';
import { TripParticipantsService } from './trip-participants.service';
import { EVENTS } from '../../config/events.constant';
import { TripId, tripIdKey } from '../utils/trip-id.util';

@Injectable()
export class TripEventEmitterService {
  private readonly logger = new Logger(TripEventEmitterService.name);

  constructor(
    private readonly connectionManager: ConnectionManagerService,
    private readonly tripParticipants: TripParticipantsService,
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

  emitAcceptedByOtherDrivers(
    io: Server,
    tripId: TripId,
    assigneeDriverId: string | number,
    context: string,
  ): void {
    const payload = { driverId: assigneeDriverId, tripId };

    for (const driverId of this.connectionManager.getAllDriverIds()) {
      if (String(driverId) === String(assigneeDriverId)) {
        continue;
      }

      this.emitDirectToDriver(
        io,
        driverId,
        EVENTS.TRIP_ACCEPTED_BY_OTHER_DRIVER,
        payload,
        context,
      );
    }
  }

  emitGlobally(
    io: Server,
    event: string,
    payload: Record<string, unknown>,
    context: string,
  ): void {
    this.logger.log(
      `[${context}] Global-emit ${event} | payload=${JSON.stringify(payload)}`,
    );
    io.emit(event, payload);
  }
}
