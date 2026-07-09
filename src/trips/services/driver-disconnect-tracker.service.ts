import { Injectable, Logger } from '@nestjs/common';
import { DRIVER_RECONNECT_WINDOW_MS } from '../../config/app.config';

interface DisconnectRecord {
  socketId: string;
  at: number;
}

/** In-memory, single-instance only — move to Redis if horizontally scaled. */
@Injectable()
export class DriverDisconnectTrackerService {
  private readonly logger = new Logger(DriverDisconnectTrackerService.name);
  private readonly disconnectedSockets = new Map<string, DisconnectRecord>();

  recordDisconnect(driverId: string | number, socketId: string): void {
    const id = String(driverId);
    this.disconnectedSockets.set(id, { socketId, at: Date.now() });
    this.logger.debug(
      `Recorded disconnect for driver ${id} socket=${socketId}`,
    );
  }

  shouldEmitDriverReconnected(
    driverId: string | number,
    newSocketId: string,
  ): boolean {
    const id = String(driverId);
    const prior = this.disconnectedSockets.get(id);
    if (!prior) {
      return false;
    }

    const withinWindow = Date.now() - prior.at < DRIVER_RECONNECT_WINDOW_MS;
    const isNewSocket = prior.socketId !== newSocketId;

    return withinWindow && isNewSocket;
  }

  clearDisconnectFlag(driverId: string | number): void {
    const id = String(driverId);
    if (this.disconnectedSockets.delete(id)) {
      this.logger.debug(`Cleared disconnect flag for driver ${id}`);
    }
  }
}
