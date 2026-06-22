import { Module } from '@nestjs/common';
import { TripsController } from './controllers/trips.controller';
import { TripsGateway } from './gateways/trips.gateway';
import { ConnectionManagerService } from './services/connection-manager.service';
import { DriverQueueService } from './services/driver-queue.service';
import { OfferManagerService } from './services/offer-manager.service';
import { BackendApiService } from './services/backend-api.service';
import { LocationCacheService } from './services/location-cache.service';
import { DisconnectGraceService } from './services/disconnect-grace.service';
import { TripParticipantsService } from './services/trip-participants.service';
import { TripEventEmitterService } from './services/trip-event-emitter.service';
import { TripLifecycleService } from './services/trip-lifecycle.service';
import { DriverStateService } from './services/driver-state.service';

@Module({
  controllers: [TripsController],
  providers: [
    TripsGateway,
    ConnectionManagerService,
    DriverQueueService,
    OfferManagerService,
    BackendApiService,
    LocationCacheService,
    DisconnectGraceService,
    TripParticipantsService,
    TripEventEmitterService,
    TripLifecycleService,
    DriverStateService,
  ],
})
export class TripsModule {}
