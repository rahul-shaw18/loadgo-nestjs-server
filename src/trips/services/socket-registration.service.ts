import { Injectable, Logger } from '@nestjs/common';
import { TripId, tripIdKey } from '../utils/trip-id.util';

interface RegistrationFingerprint {
  entityId: string;
  tripId: string | null;
  skipTripRestore: boolean;
  registeredAt: number;
}

@Injectable()
export class SocketRegistrationService {
  private readonly logger = new Logger(SocketRegistrationService.name);
  private readonly bySocket = new Map<string, RegistrationFingerprint>();

  private fingerprintKey(tripId: TripId | null | undefined): string | null {
    return tripId === undefined || tripId === null ? null : tripIdKey(tripId);
  }

  isDuplicateDriverRegister(
    socketId: string,
    driverId: string | number,
    tripId: TripId | null | undefined,
    skipTripRestore: boolean,
  ): boolean {
    return this.isDuplicate(socketId, String(driverId), tripId, skipTripRestore);
  }

  isDuplicateUserRegister(
    socketId: string,
    userId: string | number,
    tripId: TripId | null | undefined,
    skipTripRestore: boolean,
  ): boolean {
    return this.isDuplicate(socketId, String(userId), tripId, skipTripRestore);
  }

  recordDriverRegister(
    socketId: string,
    driverId: string | number,
    tripId: TripId | null | undefined,
    skipTripRestore: boolean,
  ): void {
    this.record(socketId, String(driverId), tripId, skipTripRestore);
  }

  recordUserRegister(
    socketId: string,
    userId: string | number,
    tripId: TripId | null | undefined,
    skipTripRestore: boolean,
  ): void {
    this.record(socketId, String(userId), tripId, skipTripRestore);
  }

  clearSocket(socketId: string): void {
    this.bySocket.delete(socketId);
  }

  private isDuplicate(
    socketId: string,
    entityId: string,
    tripId: TripId | null | undefined,
    skipTripRestore: boolean,
  ): boolean {
    const existing = this.bySocket.get(socketId);
    if (!existing) {
      return false;
    }

    const tripKey = this.fingerprintKey(tripId);
    const isDuplicate =
      existing.entityId === entityId &&
      existing.tripId === tripKey &&
      existing.skipTripRestore === skipTripRestore;

    if (isDuplicate) {
      this.logger.debug(
        `Registration ignored reason=duplicate socket=${socketId} entity=${entityId} trip=${tripKey ?? 'none'}`,
      );
    }

    return isDuplicate;
  }

  private record(
    socketId: string,
    entityId: string,
    tripId: TripId | null | undefined,
    skipTripRestore: boolean,
  ): void {
    this.bySocket.set(socketId, {
      entityId,
      tripId: this.fingerprintKey(tripId),
      skipTripRestore,
      registeredAt: Date.now(),
    });
  }
}
