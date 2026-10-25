export interface LocationData {
  city?: string;
  locality?: string;
  country?: string;
}

const geoCache = new Map<string, LocationData>();

export async function reverseGeocode(lat: number, lon: number): Promise<LocationData | null> {
  // Round to 3 decimal places to cluster nearby locations and save API calls (~110m accuracy)
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  
  if (geoCache.has(key)) {
    return geoCache.get(key) || null;
  }

  try {
    const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    if (!res.ok) return null;
    
    const data = await res.json();
    
    const location: LocationData = {
      city: data.city || data.locality,
      locality: data.locality,
      country: data.countryCode
    };

    geoCache.set(key, location);
    return location;
  } catch (err) {
    console.error('Geocoding error:', err);
    return null;
  }
}
