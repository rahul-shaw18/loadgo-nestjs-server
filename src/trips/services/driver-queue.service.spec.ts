import { DriverQueueService } from './driver-queue.service';

describe('DriverQueueService — ensureTripInQueue', () => {
  let queue: DriverQueueService;

  beforeEach(() => {
    jest.useFakeTimers();
    queue = new DriverQueueService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('adds a trip once and leaves an existing entry unchanged on redispath', () => {
    expect(queue.ensureTripInQueue(72, 1183)).toBe('added');
    const firstExpire = queue.getQueueEntry(72, 1183)!.bgExpireAt;

    jest.advanceTimersByTime(60_000);
    expect(queue.ensureTripInQueue(72, 1183)).toBe('exists');

    expect(queue.getQueueTripIds(72)).toEqual([1183]);
    expect(queue.getQueueEntry(72, 1183)?.bgExpireAt).toBe(firstExpire);
  });

  it('does not create a duplicate queue entry', () => {
    queue.addTripToDriver(72, 1183);
    expect(queue.addTripToDriver(72, 1183)).toBe(false);
    expect(queue.getQueueTripIds(72)).toEqual([1183]);
  });
});
