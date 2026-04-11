// ─── Socket & API Event Constants ─────────────────────────────────────────────

export const EVENTS = {
  // ─── Driver ↔ Server (socket) ───────────────────────────────────────────────
  REGISTER_DRIVER: "REGISTER_DRIVER",
  ACCEPT_OFFER: "ACCEPT_OFFER",
  REJECT_OFFER: "REJECT_OFFER",

  // ─── Server → Driver (socket) ──────────────────────────────────────────────
  OFFER_TRIP: "OFFER_TRIP",
  OFFER_EXPIRED: "OFFER_EXPIRED",
  CLOSE_RIDE_REQ: "CLOSE_RIDE_REQ",

  // ─── User ↔ Server (socket) ────────────────────────────────────────────────
  REGISTER_USER: "REGISTER_USER",

  // ─── Trip lifecycle (emitted to trip rooms) ─────────────────────────────────
  TRIP_ACCEPTED: "TRIP_ACCEPTED",
  TRIP_STARTED: "TRIP_STARTED",
  TRIP_CANCELLED: "TRIP_CANCELLED",
  TRIP_COMPLETED: "TRIP_COMPLETED",
  TRIP_CLOSED_BY_USER: "TRIP_CLOSED_BY_USER",
  RIDE_REVOKED: "RIDE_REVOKED",

  // ─── Sub-events for cancellation context ────────────────────────────────────
  RIDE_CANCEL_BY_USER: "RIDE_CANCEL_BY_USER",
  RIDE_CANCEL_BY_DRIVER: "RIDE_CANCEL_BY_DRIVER",
  RIDE_ACCEPTED_FROM_OTHER_DRIVER: "RIDE_ACCEPTED_FROM_OTHER_DRIVER",
};
