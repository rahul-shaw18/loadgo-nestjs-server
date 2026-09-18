import { TripEventEmitterService } from './trip-event-emitter.service';
import { ConnectionManagerService } from './connection-manager.service';
import { TripParticipantsService } from './trip-participants.service';
import { DriverQueueService } from './driver-queue.service';
import { EVENTS } from '../../config/events.constant';

type EmittedEvent = { target: string; event: string };

/**
 * Scenario for every test: trip 500 requested by user 7.
 * Driver A (93) is the accepting driver, drivers B/C/D (94/95/96) share the
 * offer pool, and driver 99 is unrelated (never offered this trip).
 */
describe('TripEventEmitterService — trip event scoping', () => {
  const tripId = 500;
  const userId = 7;
  const driverA = 93;
  const poolDrivers = [94, 95, 96];
  const unrelatedDriver = 99;

  let service: TripEventEmitterService;
  let connectionManager: ConnectionManagerService;
  let tripParticipants: TripParticipantsService;
  let driverQueue: DriverQueueService;
  let emitted: EmittedEvent[];
  let roomMembers: Set<string>;
  let io: import('socket.io').Server;

  const socketOfDriver = (driverId: string | number) => `socket-driver-${driverId}`;
  const socketOfUser = (id: string | number) => `socket-user-${id}`;

  const recipientsOf = (event: string): string[] =>
    emitted.filter((e) => e.event === event).map((e) => e.target);

  beforeEach(() => {
    emitted = [];
    roomMembers = new Set<string>();

    connectionManager = new ConnectionManagerService();
    tripParticipants = new TripParticipantsService();
    driverQueue = new DriverQueueService();

    for (const driverId of [driverA, ...poolDrivers, unrelatedDriver]) {
      connectionManager.addDriver(driverId, socketOfDriver(driverId));
    }
    connectionManager.addUser(userId, socketOfUser(userId));

    // Every driver except the unrelated one holds trip 500 in their queue.
    for (const driverId of [driverA, ...poolDrivers]) {
      driverQueue.ensureTripInQueue(driverId, tripId);
    }
    // The unrelated driver is busy with a different trip.
    driverQueue.ensureTripInQueue(unrelatedDriver, 777);

    io = {
      to: jest.fn((target: string) => ({
        emit: (event: string) => {
          emitted.push({ target, event });
        },
      })),
      emit: jest.fn(() => {
        throw new Error('Global broadcast is not allowed for trip events');
      }),
      sockets: {
        adapter: { rooms: new Map([['trip_500', roomMembers]]) },
        sockets: new Map(),
      },
    } as unknown as import('socket.io').Server;

    service = new TripEventEmitterService(
      connectionManager,
      tripParticipants,
      driverQueue,
    );
  });

  describe('TRIP_ACCEPTED_BY_OTHER_DRIVER', () => {
    it('reaches only the other pool drivers, never the accepting driver or the user', () => {
      service.emitAcceptedByOtherDrivers(io, tripId, driverA, 'test');

      const recipients = recipientsOf(EVENTS.TRIP_ACCEPTED_BY_OTHER_DRIVER);

      expect(recipients.sort()).toEqual(
        poolDrivers.map(socketOfDriver).sort(),
      );
      expect(recipients).not.toContain(socketOfDriver(driverA));
      expect(recipients).not.toContain(socketOfDriver(unrelatedDriver));
      expect(recipients).not.toContain(socketOfUser(userId));
    });

    it('uses a pool snapshot when the queues have already been cleared', () => {
      driverQueue.removeTripFromAllDrivers(tripId);

      service.emitAcceptedByOtherDrivers(io, tripId, driverA, 'test', {
        poolDriverIds: [driverA, ...poolDrivers],
      });

      expect(recipientsOf(EVENTS.TRIP_ACCEPTED_BY_OTHER_DRIVER).sort()).toEqual(
        poolDrivers.map(socketOfDriver).sort(),
      );
    });
  });

  describe('TRIP_CANCELLED_BY_USER', () => {
    it('reaches the user and every pool driver while the trip is still searching', () => {
      tripParticipants.setUser(tripId, userId);
      roomMembers.add(socketOfUser(userId));

      service.emitTripCancelledByUser(io, tripId, { tripId }, 'test', {
        userId,
      });

      const recipients = recipientsOf(EVENTS.TRIP_CANCELLED_BY_USER);

      expect(recipients).toContain('trip_500');
      expect(recipients).toEqual(
        expect.arrayContaining(
          [driverA, ...poolDrivers].map(socketOfDriver),
        ),
      );
      expect(recipients).not.toContain(socketOfDriver(unrelatedDriver));
    });

    it('reaches only the trip room once a driver has accepted', () => {
      tripParticipants.setUser(tripId, userId);
      tripParticipants.setDriver(tripId, driverA);
      roomMembers.add(socketOfUser(userId));
      roomMembers.add(socketOfDriver(driverA));

      service.emitTripCancelledByUser(io, tripId, { tripId }, 'test', {
        userId,
        driverId: driverA,
      });

      expect(recipientsOf(EVENTS.TRIP_CANCELLED_BY_USER)).toEqual(['trip_500']);
    });

    it('always carries the tripId in the payload', () => {
      const emit = jest.fn();
      (io.to as jest.Mock).mockReturnValue({ emit });

      service.emitTripCancelledByUser(io, tripId, { userId }, 'test', {
        userId,
        driverId: driverA,
      });

      expect(emit).toHaveBeenCalledWith(
        EVENTS.TRIP_CANCELLED_BY_USER,
        expect.objectContaining({ tripId }),
      );
    });
  });

  describe('pool targeting', () => {
    it('excludes drivers that never held the trip', () => {
      service.emitToPoolDrivers(io, tripId, EVENTS.TRIP_REVOKED, { tripId }, 'test');

      expect(recipientsOf(EVENTS.TRIP_REVOKED)).not.toContain(
        socketOfDriver(unrelatedDriver),
      );
    });

    it('reports the pool for a trip, including an explicit snapshot', () => {
      expect(service.getTripPoolDriverIds(tripId).sort()).toEqual(
        [driverA, ...poolDrivers].map(String).sort(),
      );
      expect(
        service.getTripPoolDriverIds(tripId, [unrelatedDriver]).sort(),
      ).toEqual(
        [driverA, ...poolDrivers, unrelatedDriver].map(String).sort(),
      );
    });
  });

  describe('duplicate protection', () => {
    it('detects when the user already receives trip room events', () => {
      roomMembers.add(socketOfUser(userId));
      expect(service.isUserInTripRoom(io, tripId, userId)).toBe(true);

      roomMembers.delete(socketOfUser(userId));
      expect(service.isUserInTripRoom(io, tripId, userId)).toBe(false);
    });
  });
});
