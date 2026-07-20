// ─── Socket & API Event Constants ─────────────────────────────────────────────

export const EVENTS = {
  // ─── Driver ↔ Server (socket) ───────────────────────────────────────────────
  REGISTER_DRIVER: 'REGISTER_DRIVER',
  DRIVER_LOCATION: 'DRIVER_LOCATION',

  // ─── Server → Driver (socket) ──────────────────────────────────────────────
  INCOMING_TRIP: 'INCOMING_TRIP',
  INCOMING_TRIP_EXPIRED: 'INCOMING_TRIP_EXPIRED',
  TRIP_REQUEST_TIMEOUT: 'TRIP_REQUEST_TIMEOUT',

  // ─── User ↔ Server (socket) ────────────────────────────────────────────────
  REGISTER_USER: 'REGISTER_USER',

  // ─── Trip lifecycle (emitted to trip rooms) ─────────────────────────────────
  TRIP_ACCEPTED: 'TRIP_ACCEPTED',
  TRIP_REJECTED: 'TRIP_REJECTED',
  TRIP_STARTED: 'TRIP_STARTED',
  TRIP_REVOKED: 'TRIP_REVOKED',
  TRIP_COMPLETED: 'TRIP_COMPLETED',
  TRIP_CANCELLED_BY_USER: 'TRIP_CANCELLED_BY_USER',
  TRIP_CANCELLED_BY_DRIVER: 'TRIP_CANCELLED_BY_DRIVER',
  TRIP_STATUS: 'TRIP_STATUS',

  // ─── Sub-events for cancellation context ────────────────────────────────────
  TRIP_ACCEPTED_BY_OTHER_DRIVER: 'TRIP_ACCEPTED_BY_OTHER_DRIVER',

  // ─── Live driver tracking (trip room broadcast) ─────────────────────────────
  DRIVER_LOCATION_UPDATE: 'DRIVER_LOCATION_UPDATE',

  // ─── Driver connection state (active trip only) ───────────────────────────
  DRIVER_DISCONNECTED: 'DRIVER_DISCONNECTED',
  DRIVER_RECONNECTED: 'DRIVER_RECONNECTED',
};
