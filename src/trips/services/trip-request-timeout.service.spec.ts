import { TripRequestTimeoutService, TRIP_REQUEST_TIMEOUT_MESSAGE } from './trip-request-timeout.service';
import { DriverQueueService } from './driver-queue.service';
import { OfferManagerService } from './offer-manager.service';
import { TripEventEmitterService } from './trip-event-emitter.service';
import { TripParticipantsService } from './trip-participants.service';
import { ConnectionManagerService } from './connection-manager.service';
import { LocationCacheService } from './location-cache.service';
import { TripRejectionCooldownService } from './trip-rejection-cooldown.service';
import { TripAcceptanceCacheService } from './trip-acceptance-cache.service';
import { BackendApiService } from './backend-api.service';
import { TRIP_STATUS } from '../../config/app.config';
import { EVENTS } from '../../config/events.constant';

describe('TripRequestTimeoutService', () => {
  let service: TripRequestTimeoutService;
  let driverQueue: DriverQueueService;
  let offerManager: jest.Mocked<
    Pick<
      OfferManagerService,
      'clearAllOffersForTrip' | 'getDriverIdsWithActiveOfferForTrip'
    >
  >;
  let tripEventEmitter: jest.Mocked<
    Pick<TripEventEmitterService, 'emitDirectToUser' | 'emitDirectToDriver'>
  >;
  let tripParticipants: TripParticipantsService;
  let connectionManager: jest.Mocked<Pick<ConnectionManagerService, 'leaveTripRoom'>>;
  let backendApi: jest.Mocked<Pick<BackendApiService, 'invalidateTripCache'>>;

  const io = {} as import('socket.io').Server;

  beforeEach(() => {
    driverQueue = new DriverQueueService();
    tripParticipants = new TripParticipantsService();

    offerManager = {
      clearAllOffersForTrip: jest.fn(),
      getDriverIdsWithActiveOfferForTrip: jest.fn().mockReturnValue(['93']),
    };

    tripEventEmitter = {
      emitDirectToUser: jest.fn(),
      emitDirectToDriver: jest.fn(),
    };

    connectionManager = {
      leaveTripRoom: jest.fn(),
    };

    backendApi = {
      invalidateTripCache: jest.fn(),
    };

    service = new TripRequestTimeoutService(
      driverQueue,
      offerManager as unknown as OfferManagerService,
      tripEventEmitter as unknown as TripEventEmitterService,
      tripParticipants,
      connectionManager as unknown as ConnectionManagerService,
      { clear: jest.fn() } as unknown as LocationCacheService,
      { clearAllForTrip: jest.fn() } as unknown as TripRejectionCooldownService,
      { clear: jest.fn() } as unknown as TripAcceptanceCacheService,
      backendApi as unknown as BackendApiService,
    );
  });

  it('notifies the user and cleans up when status 8 is received', () => {
    tripParticipants.setUser(1009, 7);
    driverQueue.addTripToDriver(93, 1009);

    service.handleRequestTimeout(io, 1009, 7);

    expect(tripEventEmitter.emitDirectToUser).toHaveBeenCalledWith(
      io,
      7,
      EVENTS.TRIP_REQUEST_TIMEOUT,
      {
        tripId: 1009,
        status: TRIP_STATUS.REQUEST_TIMEOUT,
        message: TRIP_REQUEST_TIMEOUT_MESSAGE,
      },
      'trip-timeout',
    );
    expect(offerManager.clearAllOffersForTrip).toHaveBeenCalledWith(io, 1009);
    expect(tripEventEmitter.emitDirectToDriver).toHaveBeenCalledWith(
      io,
      '93',
      EVENTS.TRIP_REVOKED,
      { tripId: 1009 },
      'trip-timeout:driver-revoke',
    );
    expect(connectionManager.leaveTripRoom).toHaveBeenCalledWith(io, 1009);
    expect(backendApi.invalidateTripCache).toHaveBeenCalledWith(1009);
    expect(service.isTerminal(1009)).toBe(true);
  });

  it('ignores duplicate status 8 updates', () => {
    service.handleRequestTimeout(io, 1009, 7);
    tripEventEmitter.emitDirectToUser.mockClear();

    service.handleRequestTimeout(io, 1009, 7);

    expect(tripEventEmitter.emitDirectToUser).not.toHaveBeenCalled();
  });
});
