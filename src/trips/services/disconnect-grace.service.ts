import { Injectable, Logger } from '@nestjs/common';
import { DISCONNECT_GRACE_MS } from '../../config/app.config';

@Injectable()
export class DisconnectGraceService {
  private readonly logger = new Logger(DisconnectGraceService.name);
  private readonly pendingDriverCleanups = new Map<string, NodeJS.Timeout>();

  scheduleDriverCleanup(
    driverId: string | number,
    onCleanup: () => void,
  ): void {
    const id = String(driverId);
    this.cancelDriverCleanup(id);

    const timer = setTimeout(() => {
      this.pendingDriverCleanups.delete(id);
      this.logger.log(
        `Disconnect grace expired for driver ${id}; running cleanup`,
      );
      onCleanup();
    }, DISCONNECT_GRACE_MS);

    this.pendingDriverCleanups.set(id, timer);
    this.logger.log(
      `Scheduled driver ${id} cleanup in ${DISCONNECT_GRACE_MS / 1000}s`,
    );
  }

  cancelDriverCleanup(driverId: string | number): void {
    const id = String(driverId);
    const timer = this.pendingDriverCleanups.get(id);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.pendingDriverCleanups.delete(id);
    this.logger.log(`Cancelled pending cleanup for driver ${id}`);
  }
}
