import { OfferManagerService } from './offer-manager.service';
import { DriverQueueService } from './driver-queue.service';
import { ConnectionManagerService } from './connection-manager.service';
import { DriverStateService } from './driver-state.service';
import { TripRejectionCooldownService } from './trip-rejection-cooldown.service';
import { BackendApiService } from './backend-api.service';
import { TRIP_STATUS } from '../../config/app.config';
import { EVENTS } from '../../config/events.constant';

describe('OfferManagerService — driver recovery', () => {
  let service: OfferManagerService;
  let driverQueue: DriverQueueService;
  let driverState: DriverStateService;
  let emit: jest.Mock;
  let io: import('socket.io').Server;
  let connectionManager: jest.Mocked<
    Pick<ConnectionManagerService, 'getDriverSocketId'>
  >;
  let backendApi: jest.Mocked<Pick<BackendApiService, 'fetchTripStatus'>>;

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

    service = new OfferManagerService(
      driverQueue,
      connectionManager as unknown as ConnectionManagerService,
      driverState,
      {
        isHidden: jest.fn().mockReturnValue(false),
      } as unknown as TripRejectionCooldownService,
      backendApi as unknown as BackendApiService,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

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

  it('skips trips that are no longer pending and removes them from the queue', async () => {
    driverQueue.addTripToDriver(93, 897);
    backendApi.fetchTripStatus.mockResolvedValue(TRIP_STATUS.ACCEPTED);

    await service.recoverPendingOffersOnRegister(io, 93, 'socket-93');

    expect(driverQueue.hasTripInQueue(93, 897)).toBe(false);
    expect(emit).not.toHaveBeenCalled();
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
