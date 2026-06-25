import { Injectable } from '@nestjs/common';
import { TripId, tripIdKey } from '../utils/trip-id.util';

interface TripParticipants {
  userId?: string | number;
  driverId?: string | number;
}

@Injectable()
export class TripParticipantsService {
  private readonly participantsByTrip = new Map<string, TripParticipants>();

  setUser(tripId: TripId, userId: string | number): void {
    const key = tripIdKey(tripId);
    const existing = this.participantsByTrip.get(key) ?? {};
    this.participantsByTrip.set(key, { ...existing, userId });
  }

  setDriver(tripId: TripId, driverId: string | number): void {
    const key = tripIdKey(tripId);
    const existing = this.participantsByTrip.get(key) ?? {};
    this.participantsByTrip.set(key, { ...existing, driverId });
  }

  get(tripId: TripId): TripParticipants | null {
    return this.participantsByTrip.get(tripIdKey(tripId)) ?? null;
  }

  clear(tripId: TripId): void {
    this.participantsByTrip.delete(tripIdKey(tripId));
  }

  clearDriver(driverId: string | number): void {
    const id = String(driverId);
    for (const [tripKey, participants] of this.participantsByTrip.entries()) {
      if (
        participants.driverId !== undefined &&
        String(participants.driverId) === id
      ) {
        const { driverId: _, ...rest } = participants;
        if (rest.userId === undefined) {
          this.participantsByTrip.delete(tripKey);
        } else {
          this.participantsByTrip.set(tripKey, rest);
        }
      }
    }
  }

  clearUser(userId: string | number): void {
    const id = String(userId);
    for (const [tripKey, participants] of this.participantsByTrip.entries()) {
      if (
        participants.userId !== undefined &&
        String(participants.userId) === id
      ) {
        const { userId: _, ...rest } = participants;
        if (rest.driverId === undefined) {
          this.participantsByTrip.delete(tripKey);
        } else {
          this.participantsByTrip.set(tripKey, rest);
        }
      }
    }
  }
}
