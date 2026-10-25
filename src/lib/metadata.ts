// Basic Exif/Metadata parsing utility
import ExifReader from 'exifreader';

import { reverseGeocode, LocationData } from './geocoder';

export interface ImageMetadata {
  make?: string;
  model?: string;
  dateTaken?: Date;
  width?: number;
  height?: number;
  isIPhone: boolean;
  originalExt: string;
  location?: LocationData;
}

export async function extractMetadata(file: File): Promise<ImageMetadata | null> {
  try {
    // Avoid reading the whole file into memory if it's huge, but ExifReader 
    // handles File objects smartly by using FileReader reading chunks.
    // However, just to be extremely safe with giant 4K .MOV files, we slice 
    // the first 5MB. EXIF/metadata is typically near the start.
    const fileSlice = file.slice(0, 5 * 1024 * 1024); 
    const tags = await ExifReader.load(new File([fileSlice], file.name));

    const make = tags['Make']?.description || tags['Make']?.value;
    const model = tags['Model']?.description || tags['Model']?.value;

    let dateTaken: Date | undefined;
    
    // Check multiple date fields
    const dateOriginal = tags['DateTimeOriginal']?.description;
    const creationDate = tags['CreationDate']?.description; // Often used in MP4/MOV
    
    const parseExifDate = (dateStr?: string) => {
      if (!dateStr) return undefined;
      // Exif format: "2023:05:25 14:30:00"
      if (typeof dateStr === 'string' && dateStr.includes(':') && dateStr.includes(' ')) {
        const parts = dateStr.split(' ');
        if (parts.length === 2) {
          const datePart = parts[0].replace(/:/g, '-');
          const d = new Date(`${datePart}T${parts[1]}`);
          if (!isNaN(d.getTime())) return d;
        }
      } else if (typeof dateStr === 'string' || typeof dateStr === 'number') {
           const d = new Date(dateStr);
           if (!isNaN(d.getTime())) return d;
      }
      return undefined;
    };

    dateTaken = parseExifDate(dateOriginal) || parseExifDate(creationDate);

    // Some HEIC and MOV files from Apple strictly identify via "Apple" make.
    // If not strictly identified as Apple by Make, we check the extension as a fallback.
    const originalExt = file.name.split('.').pop()?.toLowerCase() || '';
    const isIPhoneExt = ['heic', 'mov'].includes(originalExt);
    const isAppleMake = typeof make === 'string' && make.toLowerCase().includes('apple');

    let location: LocationData | undefined = undefined;
    const latDescription = tags['GPSLatitude']?.description;
    const lonDescription = tags['GPSLongitude']?.description;
    
    // GPSLatitude usually looks like a numeric string or float in description
    if (latDescription !== undefined && lonDescription !== undefined) {
      const lat = parseFloat(String(latDescription));
      const lon = parseFloat(String(lonDescription));
      if (!isNaN(lat) && !isNaN(lon)) {
        const foundLoc = await reverseGeocode(lat, lon);
        if (foundLoc) {
          location = foundLoc;
        }
      }
    }

    return {
      make: typeof make === 'string' ? make : undefined,
      model: typeof model === 'string' ? model : undefined,
      dateTaken,
      width: tags['ImageWidth']?.value as number,
      height: tags['ImageLength']?.value as number,
      isIPhone: isAppleMake || (isIPhoneExt && make !== undefined),
      originalExt,
      location
    };
  } catch (err) {
    console.error(`Failed to parse metadata for ${file.name}`, err);
    return null;
  }
}
