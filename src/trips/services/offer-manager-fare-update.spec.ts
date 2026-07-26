import { OfferManagerService } from './offer-manager.service';
import { DriverQueueService } from './driver-queue.service';
import { ConnectionManagerService } from './connection-manager.service';
import { DriverStateService } from './driver-state.service';
import { TripRejectionCooldownService } from './trip-rejection-cooldown.service';
import { BackendApiService } from './backend-api.service';
import { TripEventEmitterService } from './trip-event-emitter.service';
import { TRIP_STATUS } from '../../config/app.config';
import { EVENTS } from '../../config/events.constant';

describe('OfferManagerService — fare update redispath', () => {
  let service: OfferManagerService;
  let driverQueue: DriverQueueService;
  let driverState: DriverStateService;
  let rejectionCooldown: TripRejectionCooldownService;
  let emit: jest.Mock;
  let io: import('socket.io').Server;

  beforeEach(() => {
    jest.useFakeTimers();
    driverQueue = new DriverQueueService();
    driverState = new DriverStateService();
    rejectionCooldown = new TripRejectionCooldownService();
    emit = jest.fn();
    io = {
      to: jest.fn().mockReturnValue({ emit }),
    } as unknown as import('socket.io').Server;

    service = new OfferManagerService(
      driverQueue,
      {
        getDriverSocketId: jest.fn().mockReturnValue('socket-72'),
      } as unknown as ConnectionManagerService,
      driverState,
      rejectionCooldown,
      {
        fetchTripStatus: jest.fn().mockResolvedValue(TRIP_STATUS.REQUESTED),
      } as unknown as BackendApiService,
      {
        emitToTripRoom: jest.fn(),
      } as unknown as TripEventEmitterService,
    );
  });

  afterEach(() => {
    rejectionCooldown.onModuleDestroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('re-emits INCOMING_TRIP for an active offer without fare or timer mutation', async () => {
    driverQueue.ensureTripInQueue(72, 1183);
    const firstExpire = driverQueue.getQueueEntry(72, 1183)!.bgExpireAt;
    await service.advanceToNextOffer(io, 72, 'test');
    emit.mockClear();

    service.reemitActiveOffersForTrip(io, 1183);

    expect(driverQueue.getQueueTripIds(72)).toEqual([1183]);
    expect(driverQueue.getQueueEntry(72, 1183)?.bgExpireAt).toBe(firstExpire);
    expect(emit).toHaveBeenCalledWith(EVENTS.INCOMING_TRIP, {
      tripId: 1183,
      screenTimeout: 30,
    });
    expect(emit.mock.calls[0][1]).not.toHaveProperty('fare');
  });

  it('re-adds a previously rejected driver after cooldown reset', async () => {
    rejectionCooldown.recordRejection(72, 1183);
    expect(rejectionCooldown.isHidden(72, 1183)).toBe(true);

    rejectionCooldown.clearAllForTrip(1183);
    expect(rejectionCooldown.isHidden(72, 1183)).toBe(false);
    expect(rejectionCooldown.getRejectionCount(72, 1183)).toBe(0);

    const result = await service.dispatchTripToDriver(io, 72, 1183, {
      context: 'UPDATE_FARE',
    });

    expect(result).toBe('added');
    expect(emit).toHaveBeenCalledWith(EVENTS.INCOMING_TRIP, {
      tripId: 1183,
      screenTimeout: 30,
    });
  });

  it('leaves an existing queue entry unchanged when redispatched', async () => {
    driverQueue.ensureTripInQueue(72, 1183);
    const firstExpire = driverQueue.getQueueEntry(72, 1183)!.bgExpireAt;

    jest.advanceTimersByTime(60_000);
    const result = await service.dispatchTripToDriver(io, 72, 1183, {
      context: 'notify-new-trip',
    });

    expect(result).toBe('exists');
    expect(driverQueue.getQueueTripIds(72)).toEqual([1183]);
    expect(driverQueue.getQueueEntry(72, 1183)?.bgExpireAt).toBe(firstExpire);
  });
});
