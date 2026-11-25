import { LocationData, reverseGeocodeOffline } from './renameSession';

export type { LocationData } from './renameSession';

export async function reverseGeocode(lat: number, lon: number): Promise<LocationData | null> {
  return reverseGeocodeOffline(lat, lon);
}
