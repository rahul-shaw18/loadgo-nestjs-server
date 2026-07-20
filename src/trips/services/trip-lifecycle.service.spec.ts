import { TripLifecycleService } from './trip-lifecycle.service';
import { ConnectionManagerService } from './connection-manager.service';
import { TripParticipantsService } from './trip-participants.service';
import { LocationCacheService } from './location-cache.service';
import { OfferManagerService } from './offer-manager.service';
import { TripEventEmitterService } from './trip-event-emitter.service';
import { BackendApiService } from './backend-api.service';
import { DriverStateService } from './driver-state.service';
import { TripLifecycleLockService } from './trip-lifecycle-lock.service';
import { PendingTerminalService } from './pending-terminal.service';
import { DriverDisconnectTrackerService } from './driver-disconnect-tracker.service';
import { TripAcceptanceCacheService } from './trip-acceptance-cache.service';
import { TripRequestTimeoutService } from './trip-request-timeout.service';
import { TRIP_STATUS } from '../../config/app.config';
import { EVENTS } from '../../config/events.constant';

describe('TripLifecycleService', () => {
  let service: TripLifecycleService;
  let driverState: DriverStateService;
  let tripParticipants: TripParticipantsService;
  let acceptanceCache: TripAcceptanceCacheService;
  let backendApi: jest.Mocked<Pick<BackendApiService, 'updateTripStatus' | 'fetchTripStatus'>>;
  let offerManager: jest.Mocked<Pick<OfferManagerService, 'clearAllOffersForTrip'>>;
  let lifecycleLock: jest.Mocked<Pick<TripLifecycleLockService, 'tryAcquire' | 'release'>>;

  const io = {} as any;
  const client = {
    id: 'socket-1',
    rooms: new Set(['trip_882']),
  } as any;

  beforeEach(() => {
    driverState = new DriverStateService();
    tripParticipants = new TripParticipantsService();
    acceptanceCache = new TripAcceptanceCacheService();

    backendApi = {
      updateTripStatus: jest.fn().mockResolvedValue(true),
      fetchTripStatus: jest.fn().mockResolvedValue(TRIP_STATUS.ACCEPTED),
    };

    offerManager = {
      clearAllOffersForTrip: jest.fn(),
    };

    lifecycleLock = {
      tryAcquire: jest.fn().mockReturnValue(true),
      release: jest.fn(),
    };

    service = new TripLifecycleService(
      {
        tripRoom: jest.fn().mockReturnValue('trip_882'),
        leaveTripRoom: jest.fn(),
      } as unknown as ConnectionManagerService,
      tripParticipants,
      { clear: jest.fn() } as unknown as LocationCacheService,
      offerManager as unknown as OfferManagerService,
      {
        emitToTripRoom: jest.fn(),
        getRoomDebugInfo: jest.fn().mockReturnValue('room-debug'),
      } as unknown as TripEventEmitterService,
      backendApi as unknown as BackendApiService,
      driverState,
      lifecycleLock as unknown as TripLifecycleLockService,
      {
        clearAttempt: jest.fn(),
      } as unknown as PendingTerminalService,
      {
        clearDisconnectFlag: jest.fn(),
      } as unknown as DriverDisconnectTrackerService,
      acceptanceCache,
      {
        clearAllForTrip: jest.fn(),
      } as unknown as import('./trip-rejection-cooldown.service').TripRejectionCooldownService,
      {
        isTerminal: jest.fn().mockReturnValue(false),
      } as unknown as TripRequestTimeoutService,
    );
  });

  it('clears driver on_trip state when user cancels an accepted trip', async () => {
    const tripId = 882;
    const driverId = 93;
    const userId = 7;

    tripParticipants.setDriver(tripId, driverId);
    tripParticipants.setUser(tripId, userId);
    driverState.setOnTrip(driverId, tripId);
    acceptanceCache.set({ tripId, driverId });

    const result = await service.processUserLifecycle(io, client, {
      event: EVENTS.TRIP_CANCELLED_BY_USER,
      status: TRIP_STATUS.CANCELLED_BY_USER,
      tripId,
      userId,
      broadcastPayload: { tripId, userId },
      context: 'test-cancelled-by-user',
    });

    expect(result.ok).toBe(true);
    expect(driverState.canReceiveOffers(driverId)).toBe(true);
    expect(driverState.getActiveTripId(driverId)).toBeNull();
    expect(acceptanceCache.get(tripId)).toBeNull();
    expect(offerManager.clearAllOffersForTrip).toHaveBeenCalledWith(
      io,
      tripId,
      driverId,
    );
  });

  it('clears driver on_trip state even when trip participants were already cleared', async () => {
    const tripId = 882;
    const driverId = 93;
    const userId = 7;

    tripParticipants.setUser(tripId, userId);
    driverState.setOnTrip(driverId, tripId);

    const result = await service.processUserLifecycle(io, client, {
      event: EVENTS.TRIP_CANCELLED_BY_USER,
      status: TRIP_STATUS.CANCELLED_BY_USER,
      tripId,
      userId,
      broadcastPayload: { tripId, userId },
      context: 'test-cancelled-by-user-no-participants',
    });

    expect(result.ok).toBe(true);
    expect(driverState.canReceiveOffers(driverId)).toBe(true);
    expect(driverState.getActiveTripId(driverId)).toBeNull();
  });
});
