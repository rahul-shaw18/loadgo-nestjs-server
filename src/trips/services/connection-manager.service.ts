import { Injectable, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { joinRoomIfNeeded } from '../utils/room.util';

@Injectable()
export class ConnectionManagerService {
  private readonly logger = new Logger(ConnectionManagerService.name);

  private onlineDrivers: Record<string, string> = {};
  private onlineUsers: Record<string, string> = {};

  tripRoom(tripId: number | string): string {
    return `trip_${tripId}`;
  }

  driverRoom(driverId: string | number): string {
    return `driver_${driverId}`;
  }

  addDriver(driverId: string | number, socketId: string): boolean {
    const id = String(driverId);
    if (this.onlineDrivers[id] === socketId) {
      return false;
    }

    this.onlineDrivers[id] = socketId;
    this.logger.log(`Driver ${driverId} connected (socket: ${socketId})`);
    return true;
  }

  removeDriverBySocketId(socketId: string): string | null {
    const driverId = Object.keys(this.onlineDrivers).find(
      (id) => this.onlineDrivers[id] === socketId,
    );
    if (driverId) {
      delete this.onlineDrivers[driverId];
      this.logger.log(`Driver ${driverId} disconnected`);
    }
    return driverId || null;
  }

  getDriverSocketId(driverId: string | number): string | null {
    return this.onlineDrivers[String(driverId)] || null;
  }

  getAllDriverIds(): string[] {
    return Object.keys(this.onlineDrivers);
  }

  findDriverIdBySocket(socketId: string): string | null {
    return (
      Object.keys(this.onlineDrivers).find(
        (id) => this.onlineDrivers[id] === socketId,
      ) ?? null
    );
  }

  getAllUserIds(): string[] {
    return Object.keys(this.onlineUsers);
  }

  findUserIdBySocket(socketId: string): string | null {
    return (
      Object.keys(this.onlineUsers).find(
        (id) => this.onlineUsers[id] === socketId,
      ) ?? null
    );
  }

  addUser(userId: string | number, socketId: string): boolean {
    const id = String(userId);
    if (this.onlineUsers[id] === socketId) {
      return false;
    }

    this.onlineUsers[id] = socketId;
    this.logger.log(`User ${userId} connected (socket: ${socketId})`);
    return true;
  }

  removeUserBySocketId(socketId: string): string | null {
    const userId = Object.keys(this.onlineUsers).find(
      (id) => this.onlineUsers[id] === socketId,
    );
    if (userId) {
      delete this.onlineUsers[userId];
      this.logger.log(`User ${userId} disconnected`);
    }
    return userId || null;
  }

  getUserSocketId(userId: string | number): string | null {
    return this.onlineUsers[String(userId)] || null;
  }

  joinDriverPersonalRoom(
    io: Server,
    driverId: string | number,
    socket?: Socket,
  ): void {
    const room = this.driverRoom(driverId);
    const targetSocket =
      socket ?? io.sockets.sockets.get(this.onlineDrivers[String(driverId)]);

    if (targetSocket && joinRoomIfNeeded(targetSocket, room)) {
      this.logger.log(
        `Driver ${driverId} joined personal room ${room} (socket: ${targetSocket.id})`,
      );
    }
  }

  joinDriverToTripRoom(
    io: Server,
    driverId: string | number,
    tripId: string | number,
  ): void {
    const socketId = this.onlineDrivers[String(driverId)];
    if (!socketId) {
      this.logger.warn(
        `Driver ${driverId} not online — cannot join room ${this.tripRoom(tripId)}`,
      );
      return;
    }

    const socket = io.sockets.sockets.get(socketId);
    if (!socket) {
      return;
    }

    const room = this.tripRoom(tripId);
    if (joinRoomIfNeeded(socket, room)) {
      this.logger.log(
        `Driver ${driverId} joined room ${room} (socket: ${socketId})`,
      );
    }
  }

  joinUserToTripRoom(
    io: Server,
    userId: string | number,
    tripId: string | number,
  ): void {
    const socketId = this.onlineUsers[String(userId)];
    if (!socketId) {
      this.logger.warn(
        `User ${userId} not online — cannot join room ${this.tripRoom(tripId)}`,
      );
      return;
    }

    const socket = io.sockets.sockets.get(socketId);
    if (!socket) {
      return;
    }

    const room = this.tripRoom(tripId);
    if (joinRoomIfNeeded(socket, room)) {
      this.logger.log(`User ${userId} joined room ${room} (socket: ${socketId})`);
    }
  }

  joinSocketToTripRoom(socket: Socket, tripId: string | number): void {
    const room = this.tripRoom(tripId);
    if (joinRoomIfNeeded(socket, room)) {
      this.logger.log(
        `Socket ${socket.id} joined room ${room}`,
      );
    }
  }

  leaveTripRoom(io: Server, tripId: string | number): void {
    const room = this.tripRoom(tripId);
    io.in(room).socketsLeave(room);
    this.logger.log(`All sockets left room ${room}`);
  }

  leaveDriverFromTripRoom(
    io: Server,
    driverId: string | number,
    tripId: string | number,
  ): void {
    const socketId = this.onlineDrivers[String(driverId)];
    if (!socketId) {
      return;
    }

    const socket = io.sockets.sockets.get(socketId);
    if (!socket) {
      return;
    }

    const room = this.tripRoom(tripId);
    socket.leave(room);
    this.logger.log(
      `Driver ${driverId} left room ${room} (socket: ${socketId})`,
    );
  }

  leaveUserFromTripRoom(
    io: Server,
    userId: string | number,
    tripId: string | number,
  ): void {
    const socketId = this.onlineUsers[String(userId)];
    if (!socketId) {
      return;
    }

    const socket = io.sockets.sockets.get(socketId);
    if (!socket) {
      return;
    }

    const room = this.tripRoom(tripId);
    socket.leave(room);
    this.logger.log(`User ${userId} left room ${room} (socket: ${socketId})`);
  }
}
