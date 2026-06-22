// ─── Server Configuration ─────────────────────────────────────────────────────

export const BACKEND_BASE_URL =
  process.env.BACKEND_URL || 'https://loadgo.in/loadgotest/';

/** Optional service JWT for server-to-server PHP API calls */
export const BACKEND_SERVICE_TOKEN = process.env.BACKEND_SERVICE_TOKEN || '';

// Timer durations (in milliseconds)
export const SCREEN_TIMER_MS = 30 * 1000; // 30 seconds — time shown on driver screen per trip
export const BACKGROUND_TIMER_MS = 5 * 60 * 1000; // 5 minutes — total lifetime of a trip in a driver's queue
export const ROTATION_GAP_MS = 3 * 1000; // 3 seconds — gap between trip rotations
export const LOCATION_UPDATE_THROTTLE_MS = 1000; // 1 second — max location broadcasts per driver
export const DISCONNECT_GRACE_MS = 30 * 1000; // 30 seconds — grace before driver queue cleanup

/** Trip API status codes considered "active" for socket room rejoin */
export const ACTIVE_TRIP_STATUSES = [2, 4] as const;

/** Trip lifecycle status codes sent to patchLiveTripData.php */
export const TRIP_STATUS = {
  ACCEPTED: 2,
  STARTED: 4,
  COMPLETED: 5,
  CANCELLED_BY_USER: 6,
  CANCELLED_BY_DRIVER: 7,
} as const;

export const BACKEND_ENDPOINTS = {
  PATCH_LIVE_TRIP:
    process.env.BACKEND_PATCH_LIVE_TRIP_PATH || 'patchLiveTripData.php',
  PATCH_DRIVER: process.env.BACKEND_PATCH_DRIVER_PATH || 'patchDriver.php',
  GET_LIVE_TRIP:
    process.env.BACKEND_GET_LIVE_TRIP_PATH || 'getLiveTripData.php',
};
