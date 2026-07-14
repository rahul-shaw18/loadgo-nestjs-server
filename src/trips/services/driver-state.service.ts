import { Injectable, Logger } from '@nestjs/common';
import { TripId, tripIdKey, tripIdsEqual } from '../utils/trip-id.util';

export type DriverAvailability = 'online' | 'on_trip' | 'offline' | 'reconnecting';

interface DriverState {
  status: DriverAvailability;
  activeTripId: TripId | null;
  vehicleNo?: string;
}

@Injectable()
export class DriverStateService {
  private readonly logger = new Logger(DriverStateService.name);
  private readonly states = new Map<string, DriverState>();

  private getOrCreate(driverId: string | number): DriverState {
    const id = String(driverId);
    if (!this.states.has(id)) {
      this.states.set(id, { status: 'online', activeTripId: null });
    }
    return this.states.get(id)!;
  }

  setOnline(driverId: string | number): void {
    const state = this.getOrCreate(driverId);
    state.status = 'online';
    state.activeTripId = null;
    this.logger.log(`Driver ${driverId} state → online`);
  }

  setReconnecting(driverId: string | number): void {
    const state = this.getOrCreate(driverId);
    state.status = 'reconnecting';
    this.logger.log(`Driver ${driverId} state → reconnecting`);
  }

  isReconnecting(driverId: string | number): boolean {
    return this.getOrCreate(driverId).status === 'reconnecting';
  }

  setOnTrip(
    driverId: string | number,
    tripId: TripId,
    vehicleNo?: string,
  ): void {
    const state = this.getOrCreate(driverId);
    state.status = 'on_trip';
    state.activeTripId = tripId;
    if (vehicleNo !== undefined) {
      state.vehicleNo = vehicleNo;
    }
    this.logger.log(
      `Driver ${driverId} state → on_trip (trip ${tripIdKey(tripId)})`,
    );
  }

  setOffline(driverId: string | number): void {
    const id = String(driverId);
    this.states.delete(id);
    this.logger.log(`Driver ${driverId} state → offline (removed)`);
  }

  isOnTrip(driverId: string | number): boolean {
    return this.getOrCreate(driverId).status === 'on_trip';
  }

  canReceiveOffers(driverId: string | number): boolean {
    const status = this.getOrCreate(driverId).status;
    return status === 'online' || status === 'reconnecting';
  }

  getActiveTripId(driverId: string | number): TripId | null {
    return this.getOrCreate(driverId).activeTripId;
  }

  getVehicleNo(driverId: string | number): string | undefined {
    return this.getOrCreate(driverId).vehicleNo;
  }

  setVehicleNo(driverId: string | number, vehicleNo: string): void {
    this.getOrCreate(driverId).vehicleNo = vehicleNo;
  }

  isAssigneeForTrip(driverId: string | number, tripId: TripId): boolean {
    const state = this.getOrCreate(driverId);
    return (
      state.status === 'on_trip' &&
      state.activeTripId !== null &&
      tripIdsEqual(state.activeTripId, tripId)
    );
  }

  findDriverOnTrip(tripId: TripId): string | null {
    for (const [driverId, state] of this.states.entries()) {
      if (
        state.status === 'on_trip' &&
        state.activeTripId !== null &&
        tripIdsEqual(state.activeTripId, tripId)
      ) {
        return driverId;
      }
    }
    return null;
  }
}
