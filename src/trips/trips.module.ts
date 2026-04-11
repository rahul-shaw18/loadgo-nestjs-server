import { Module } from '@nestjs/common';
import { TripsController } from './controllers/trips.controller';
import { TripsGateway } from './gateways/trips.gateway';
import { ConnectionManagerService } from './services/connection-manager.service';
import { DriverQueueService } from './services/driver-queue.service';
import { OfferManagerService } from './services/offer-manager.service';

@Module({
  controllers: [TripsController],
  providers: [
    TripsGateway,
    ConnectionManagerService,
    DriverQueueService,
    OfferManagerService,
  ],
})
export class TripsModule {}
