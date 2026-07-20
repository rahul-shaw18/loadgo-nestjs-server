// ─── Server Configuration ─────────────────────────────────────────────────────

export const BACKEND_BASE_URL =
  process.env.BACKEND_URL || 'https://loadgo.in/loadgotest/';

/** Optional service JWT for server-to-server PHP API calls */
export const BACKEND_SERVICE_TOKEN = process.env.BACKEND_SERVICE_TOKEN || '';

// Timer durations (in milliseconds)
export const SCREEN_TIMER_MS = 30 * 1000; // 30 seconds — time shown on driver screen per trip
export const BACKGROUND_TIMER_MS = 5 * 60 * 1000; // 5 minutes — total lifetime of a trip in a driver's queue
export const ROTATION_GAP_MS = 5 * 1000; // 5 seconds — gap between trip rotations
export const LOCATION_UPDATE_THROTTLE_MS = 1000; // 1 second — max location broadcasts per driver
export const DISCONNECT_GRACE_MS = 30 * 1000; // 30 seconds — grace before driver queue cleanup
export const REJECTION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes — hide rejected trip from driver
export const TRIP_LOOKUP_CACHE_TTL_MS = 8 * 1000; // collapse burst getLiveTripData calls
export const PENDING_TERMINAL_COOLDOWN_MS = 30 * 1000; // block stale restore after failed complete
export const DRIVER_RECONNECT_WINDOW_MS = 5 * 60 * 1000; // emit DRIVER_RECONNECTED window

export const SOCKET_PING_INTERVAL_MS = 15 * 1000;
export const SOCKET_PING_TIMEOUT_MS = 30 * 1000;

/** Trip API status codes considered "active" for socket room rejoin */
export const ACTIVE_TRIP_STATUSES = [2, 4] as const;

/** Trip lifecycle status codes sent to patchLiveTripData.php */
export const TRIP_STATUS = {
  REQUESTED: 1,
  ACCEPTED: 2,
  STARTED: 4,
  COMPLETED: 5,
  CANCELLED_BY_USER: 6,
  CANCELLED_BY_DRIVER: 7,
  REQUEST_TIMEOUT: 8,
} as const;

export const BACKEND_ENDPOINTS = {
  PATCH_LIVE_TRIP:
    process.env.BACKEND_PATCH_LIVE_TRIP_PATH || 'patchLiveTripData.php',
  PATCH_DRIVER: process.env.BACKEND_PATCH_DRIVER_PATH || 'patchDriver.php',
  GET_LIVE_TRIP:
    process.env.BACKEND_GET_LIVE_TRIP_PATH || 'getLiveTripData.php',
};
