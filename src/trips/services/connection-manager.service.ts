import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';

@Injectable()
export class ConnectionManagerService {
  private readonly logger = new Logger(ConnectionManagerService.name);

  // state
  private onlineDrivers: Record<string, string> = {};
  private onlineUsers: Record<string, string> = {};

  // Room helper
  tripRoom(tripId: number | string): string {
    return `trip_${tripId}`;
  }

  // ─── Driver methods ───
  addDriver(driverId: string | number, socketId: string) {
    this.onlineDrivers[String(driverId)] = socketId;
    this.logger.log(`Driver ${driverId} connected (socket: ${socketId})`);
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

  // ─── User methods ───
  addUser(userId: string | number, socketId: string) {
    this.onlineUsers[String(userId)] = socketId;
    this.logger.log(`User ${userId} connected (socket: ${socketId})`);
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

  // ─── Room operations ───
  joinDriverToTripRoom(io: Server, driverId: string | number, tripId: string | number) {
    const socketId = this.onlineDrivers[String(driverId)];
    if (!socketId) return;

    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.join(this.tripRoom(tripId));
      this.logger.debug(`Driver ${driverId} joined room ${this.tripRoom(tripId)}`);
    }
  }

  joinUserToTripRoom(io: Server, userId: string | number, tripId: string | number) {
    const socketId = this.onlineUsers[String(userId)];
    if (!socketId) return;

    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.join(this.tripRoom(tripId));
      this.logger.debug(`User ${userId} joined room ${this.tripRoom(tripId)}`);
    }
  }
}
