import { TripAcceptanceCacheService } from './trip-acceptance-cache.service';

describe('TripAcceptanceCacheService', () => {
  let cache: TripAcceptanceCacheService;

  beforeEach(() => {
    cache = new TripAcceptanceCacheService();
  });

  it('keeps acceptance until explicitly cleared (no TTL)', () => {
    cache.set({ tripId: 828, driverId: 93, vehicleNo: 'ABC' });

    expect(cache.get(828)).toEqual({
      tripId: 828,
      driverId: 93,
      vehicleNo: 'ABC',
    });

    cache.clear(828);
    expect(cache.get(828)).toBeNull();
  });

  it('does not clear other trips when clearing one', () => {
    cache.set({ tripId: 828, driverId: 93 });
    cache.set({ tripId: 829, driverId: 50 });

    cache.clear(828);

    expect(cache.get(828)).toBeNull();
    expect(cache.get(829)?.driverId).toBe(50);
  });
});
