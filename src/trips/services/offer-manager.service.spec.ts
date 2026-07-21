import { OfferManagerService } from './offer-manager.service';
import { DriverQueueService } from './driver-queue.service';
import { ConnectionManagerService } from './connection-manager.service';
import { DriverStateService } from './driver-state.service';
import { TripRejectionCooldownService } from './trip-rejection-cooldown.service';
import { BackendApiService } from './backend-api.service';
import { TripEventEmitterService } from './trip-event-emitter.service';
import { TRIP_STATUS } from '../../config/app.config';
import { EVENTS } from '../../config/events.constant';

describe('OfferManagerService', () => {
  let service: OfferManagerService;
  let driverQueue: DriverQueueService;
  let driverState: DriverStateService;
  let emit: jest.Mock;
  let io: import('socket.io').Server;
  let connectionManager: jest.Mocked<
    Pick<ConnectionManagerService, 'getDriverSocketId'>
  >;
  let backendApi: jest.Mocked<Pick<BackendApiService, 'fetchTripStatus'>>;
  let tripEventEmitter: jest.Mocked<Pick<TripEventEmitterService, 'emitToTripRoom'>>;

  beforeEach(() => {
    jest.useFakeTimers();

    driverQueue = new DriverQueueService();
    driverState = new DriverStateService();
    emit = jest.fn();
    io = {
      to: jest.fn().mockReturnValue({ emit }),
    } as unknown as import('socket.io').Server;

    connectionManager = {
      getDriverSocketId: jest.fn().mockReturnValue('socket-93'),
    };
    backendApi = {
      fetchTripStatus: jest.fn().mockResolvedValue(TRIP_STATUS.REQUESTED),
    };
    tripEventEmitter = {
      emitToTripRoom: jest.fn(),
    };

    service = new OfferManagerService(
      driverQueue,
      connectionManager as unknown as ConnectionManagerService,
      driverState,
      {
        isHidden: jest.fn().mockReturnValue(false),
      } as unknown as TripRejectionCooldownService,
      backendApi as unknown as BackendApiService,
      tripEventEmitter as unknown as TripEventEmitterService,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('sequential queue', () => {
    it('presents only the first queued trip when multiple trips are assigned', async () => {
      driverQueue.addTripToDriver(93, 1009);
      driverQueue.addTripToDriver(93, 1012);
      driverQueue.addTripToDriver(93, 1014);

      await service.advanceToNextOffer(io, 93, 'test');

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(EVENTS.INCOMING_TRIP, {
        tripId: 1009,
        screenTimeout: 30,
      });
      expect(service.hasOffer(93)).toBe(true);
      expect(driverQueue.getQueueTripIds(93)).toEqual([1009, 1012, 1014]);
    });

    it('clears the entire queue when the driver accepts the active trip', () => {
      driverQueue.addTripToDriver(93, 1009);
      driverQueue.addTripToDriver(93, 1012);

      const result = service.handleAccept(93, 1009);

      expect(result.valid).toBe(true);
      expect(driverQueue.getQueueSize(93)).toBe(0);
      expect(service.hasOffer(93)).toBe(false);
    });

    it('presents the next valid trip after reject', async () => {
      driverQueue.addTripToDriver(93, 1009);
      driverQueue.addTripToDriver(93, 1012);

      await service.advanceToNextOffer(io, 93, 'test');
      service.handleReject(io, 93, 1009);

      await jest.advanceTimersByTimeAsync(5000);

      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenLastCalledWith(EVENTS.INCOMING_TRIP, {
        tripId: 1012,
        screenTimeout: 30,
      });
    });

    it('emits TRIP_REQUEST_TIMEOUT to the trip room when the offer screen timer expires', async () => {
      driverQueue.addTripToDriver(93, 1009);

      await service.advanceToNextOffer(io, 93, 'test');
      await jest.advanceTimersByTimeAsync(30_000);

      expect(tripEventEmitter.emitToTripRoom).toHaveBeenCalledWith(
        io,
        1009,
        EVENTS.TRIP_REQUEST_TIMEOUT,
        { tripId: 1009, driverId: '93' },
        'offer-screen-timeout',
        { driverId: '93' },
      );
    });

    it('skips trips that are no longer pending and offers the next valid one', async () => {
      driverQueue.addTripToDriver(93, 1009);
      driverQueue.addTripToDriver(93, 1012);

      backendApi.fetchTripStatus.mockImplementation(async (tripId) => {
        if (tripId === 1009) return TRIP_STATUS.ACCEPTED;
        return TRIP_STATUS.REQUESTED;
      });

      await service.advanceToNextOffer(io, 93, 'test');

      expect(driverQueue.hasTripInQueue(93, 1009)).toBe(false);
      expect(emit).toHaveBeenCalledWith(EVENTS.INCOMING_TRIP, {
        tripId: 1012,
        screenTimeout: 30,
      });
    });

    it('still offers a trip when status lookup returns unknown/null instead of removing it', async () => {
      driverQueue.addTripToDriver(93, 1046);
      driverQueue.addTripToDriver(93, 1047);
      backendApi.fetchTripStatus.mockResolvedValue(null);

      await service.advanceToNextOffer(io, 93, 'reject');

      expect(driverQueue.hasTripInQueue(93, 1046)).toBe(true);
      expect(emit).toHaveBeenCalledWith(EVENTS.INCOMING_TRIP, {
        tripId: 1046,
        screenTimeout: 30,
      });
    });

    it('continues past known-invalid trips and offers the first valid one', async () => {
      driverQueue.addTripToDriver(93, 1046);
      driverQueue.addTripToDriver(93, 1047);
      driverQueue.addTripToDriver(93, 1048);

      backendApi.fetchTripStatus.mockImplementation(async (tripId) => {
        if (tripId === 1046) return null;
        if (tripId === 1047) return TRIP_STATUS.ACCEPTED;
        return TRIP_STATUS.REQUESTED;
      });

      await service.advanceToNextOffer(io, 93, 'test');

      // null status keeps 1046 and offers it optimistically
      expect(emit).toHaveBeenCalledWith(EVENTS.INCOMING_TRIP, {
        tripId: 1046,
        screenTimeout: 30,
      });
      expect(driverQueue.hasTripInQueue(93, 1046)).toBe(true);
    });

    it('skips accepted trips then offers the next after reject-style advance', async () => {
      driverQueue.addTripToDriver(93, 1046);
      driverQueue.addTripToDriver(93, 1047);

      backendApi.fetchTripStatus.mockImplementation(async (tripId) => {
        if (tripId === 1046) return TRIP_STATUS.COMPLETED;
        return TRIP_STATUS.REQUESTED;
      });

      await service.advanceToNextOffer(io, 93, 'reject');

      expect(driverQueue.hasTripInQueue(93, 1046)).toBe(false);
      expect(emit).toHaveBeenCalledWith(EVENTS.INCOMING_TRIP, {
        tripId: 1047,
        screenTimeout: 30,
      });
    });

    it('continues queue processing when validation throws for one trip', async () => {
      driverQueue.addTripToDriver(93, 1046);
      driverQueue.addTripToDriver(93, 1047);

      backendApi.fetchTripStatus
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValue(TRIP_STATUS.REQUESTED);

      await service.advanceToNextOffer(io, 93, 'test');

      // thrown validation is treated as optimistic offer for 1046
      expect(emit).toHaveBeenCalledWith(EVENTS.INCOMING_TRIP, {
        tripId: 1046,
        screenTimeout: 30,
      });
    });
  });

  describe('driver recovery', () => {
    it('re-emits INCOMING_TRIP with a fresh 30s timer when driver reconnects', async () => {
      driverQueue.addTripToDriver(93, 901);

      await service.recoverPendingOffersOnRegister(io, 93, 'socket-93');

      expect(backendApi.fetchTripStatus).toHaveBeenCalledWith(901);
      expect(emit).toHaveBeenCalledWith(EVENTS.INCOMING_TRIP, {
        tripId: 901,
        screenTimeout: 30,
      });
      expect(service.hasOfferSentOnSocket('socket-93', 901)).toBe(true);
    });

    it('does not duplicate INCOMING_TRIP on the same socket connection', async () => {
      driverQueue.addTripToDriver(93, 901);

      await service.recoverPendingOffersOnRegister(io, 93, 'socket-93');
      await service.recoverPendingOffersOnRegister(io, 93, 'socket-93');

      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('preserves the driver queue during grace cleanup', () => {
      driverQueue.addTripToDriver(93, 901);
      driverState.setReconnecting(93);

      service.cleanupDriver(93);

      expect(driverQueue.getQueueSize(93)).toBe(1);
    });
  });
});
