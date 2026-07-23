import {
  rejectionCooldownMsForCount,
  REJECTION_COOLDOWN_INITIAL_MS,
  REJECTION_COOLDOWN_SECOND_MS,
  REJECTION_COOLDOWN_STEP_MS,
} from '../../config/app.config';
import { TripRejectionCooldownService } from './trip-rejection-cooldown.service';

describe('rejectionCooldownMsForCount', () => {
  it('matches the gradual progression table', () => {
    expect(rejectionCooldownMsForCount(1)).toBe(REJECTION_COOLDOWN_INITIAL_MS);
    expect(rejectionCooldownMsForCount(2)).toBe(REJECTION_COOLDOWN_SECOND_MS);
    expect(rejectionCooldownMsForCount(3)).toBe(
      REJECTION_COOLDOWN_SECOND_MS + REJECTION_COOLDOWN_STEP_MS,
    );
    expect(rejectionCooldownMsForCount(4)).toBe(
      REJECTION_COOLDOWN_SECOND_MS + 2 * REJECTION_COOLDOWN_STEP_MS,
    );
    expect(rejectionCooldownMsForCount(5)).toBe(
      REJECTION_COOLDOWN_SECOND_MS + 3 * REJECTION_COOLDOWN_STEP_MS,
    );

    expect(rejectionCooldownMsForCount(1) / 1000).toBe(30);
    expect(rejectionCooldownMsForCount(2) / 1000).toBe(60);
    expect(rejectionCooldownMsForCount(3) / 1000).toBe(110);
    expect(rejectionCooldownMsForCount(4) / 1000).toBe(160);
    expect(rejectionCooldownMsForCount(5) / 1000).toBe(210);
  });
});

describe('TripRejectionCooldownService', () => {
  let service: TripRejectionCooldownService;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new TripRejectionCooldownService();
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('increases cooldown per driver per trip on consecutive rejections', () => {
    service.recordRejection(98, 1050);
    expect(service.isHidden(98, 1050)).toBe(true);
    expect(service.getRejectionCount(98, 1050)).toBe(1);

    jest.advanceTimersByTime(30_000);
    expect(service.isHidden(98, 1050)).toBe(false);
    expect(service.getRejectionCount(98, 1050)).toBe(1);

    service.recordRejection(98, 1050);
    expect(service.getRejectionCount(98, 1050)).toBe(2);
    expect(service.isHidden(98, 1050)).toBe(true);

    jest.advanceTimersByTime(59_000);
    expect(service.isHidden(98, 1050)).toBe(true);
    jest.advanceTimersByTime(1_000);
    expect(service.isHidden(98, 1050)).toBe(false);

    service.recordRejection(98, 1050);
    expect(service.getRejectionCount(98, 1050)).toBe(3);
  });

  it('scopes cooldown independently per trip and per driver', () => {
    service.recordRejection(98, 1050);
    service.recordRejection(98, 1050);
    service.recordRejection(91, 1050);

    expect(service.getRejectionCount(98, 1050)).toBe(2);
    expect(service.getRejectionCount(91, 1050)).toBe(1);
    expect(service.getRejectionCount(98, 1051)).toBe(0);
  });

  it('clears rejection history when the trip is terminated', () => {
    service.recordRejection(98, 1050);
    service.recordRejection(98, 1050);
    service.recordRejection(91, 1050);

    service.clearAllForTrip(1050);

    expect(service.getRejectionCount(98, 1050)).toBe(0);
    expect(service.getRejectionCount(91, 1050)).toBe(0);
    expect(service.isHidden(98, 1050)).toBe(false);
  });
});
