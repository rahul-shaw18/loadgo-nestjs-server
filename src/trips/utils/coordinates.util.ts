export type CoordinateInput = number | string | undefined | null;

export function parseCoordinate(value: CoordinateInput): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numeric =
    typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return numeric;
}

export function isValidCoordinatePair(latitude: number, longitude: number): boolean {
  return (
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/** Preserve precision — keep the original string when provided. */
export function formatCoordinateForBackend(
  value: CoordinateInput,
): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || !Number.isFinite(Number(trimmed))) {
      return null;
    }
    return trimmed;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

export interface DriverCoordinates {
  lat: string;
  lng: string;
}

export interface DriverCoordinatePayload {
  lat?: CoordinateInput;
  lng?: CoordinateInput;
  latitude?: CoordinateInput;
  longitude?: CoordinateInput;
}

export function resolveDriverCoordinates(
  payload: DriverCoordinatePayload,
): DriverCoordinates | null {
  const lat = formatCoordinateForBackend(payload.lat ?? payload.latitude);
  const lng = formatCoordinateForBackend(payload.lng ?? payload.longitude);

  if (!lat || !lng) {
    return null;
  }

  const latNum = parseCoordinate(lat);
  const lngNum = parseCoordinate(lng);

  if (
    latNum === null ||
    lngNum === null ||
    !isValidCoordinatePair(latNum, lngNum)
  ) {
    return null;
  }

  return { lat, lng };
}
