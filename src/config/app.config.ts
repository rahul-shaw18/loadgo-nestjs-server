// ─── Server Configuration ─────────────────────────────────────────────────────

export const BACKEND_BASE_URL = process.env.BACKEND_URL || "https://loadgo.in/loadgotest/";

// Timer durations (in milliseconds)
export const SCREEN_TIMER_MS = 30 * 1000;       // 30 seconds — time shown on driver screen per trip
export const BACKGROUND_TIMER_MS = 5 * 60 * 1000; // 5 minutes — total lifetime of a trip in a driver's queue
export const ROTATION_GAP_MS = 3 * 1000;        // 3 seconds — gap between trip rotations
