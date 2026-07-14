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
import { TripRejectionCooldownService } from './services/trip-rejection-cooldown.service';
import { SocketRegistrationService } from './services/socket-registration.service';
import { DriverDisconnectTrackerService } from './services/driver-disconnect-tracker.service';
import { PendingTerminalService } from './services/pending-terminal.service';
import { TripLifecycleLockService } from './services/trip-lifecycle-lock.service';
import { TripAcceptanceCacheService } from './services/trip-acceptance-cache.service';

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
    TripRejectionCooldownService,
    SocketRegistrationService,
    DriverDisconnectTrackerService,
    PendingTerminalService,
    TripLifecycleLockService,
    TripAcceptanceCacheService,
  ],
})
export class TripsModule {}
