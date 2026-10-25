import { format } from 'date-fns';
import { ImageMetadata } from './metadata';
import { ProcessedFile } from '../hooks/useFileSystem';

export function computePreviews(files: ProcessedFile[], template: string): ProcessedFile[] {
  const seenNames = new Set<string>();
  
  return files.map(item => {
    let baseName = generateNewNameBase(item.file, item.metadata, template);
    let ext = '.' + (item.file.name.split('.').pop() || '');
    
    let tentativeName = baseName + ext;
    let counter = 1;
    
    while (seenNames.has(tentativeName)) {
      tentativeName = `${baseName}_${counter}${ext}`;
      counter++;
    }
    
    seenNames.add(tentativeName);
    
    return {
      ...item,
      newNamePreview: tentativeName
    };
  });
}

function generateNewNameBase(file: File, metadata: ImageMetadata | null, template: string): string {
  const originalExt = file.name.split('.').pop() || '';
  
  // Default fallback if metadata missing, use file.lastModified
  const dateToUse = metadata?.dateTaken || new Date(file.lastModified);
  const modelStr = metadata?.model?.replace(/[^a-zA-Z0-9_-]/g, '') || 'UnknownDevice';
  const originalBase = file.name.substring(0, file.name.lastIndexOf('.'));
  const cityStr = metadata?.location?.city?.replace(/[^a-zA-Z0-9_-]/g, '') || 'UnknownLocation';
  
  // Parse template
  let newName = template;
  
  newName = newName.replace(/{YYYY}/g, format(dateToUse, 'yyyy'));
  newName = newName.replace(/{MM}/g, format(dateToUse, 'MM'));
  newName = newName.replace(/{DD}/g, format(dateToUse, 'dd'));
  newName = newName.replace(/{HH}/g, format(dateToUse, 'HH'));
  newName = newName.replace(/{mm}/g, format(dateToUse, 'mm'));
  newName = newName.replace(/{ss}/g, format(dateToUse, 'ss'));
  newName = newName.replace(/{Model}/g, modelStr);
  newName = newName.replace(/{City}/g, cityStr);
  newName = newName.replace(/{Original}/g, originalBase);
  
  return sanitizeFilename(newName);
}

function sanitizeFilename(name: string): string {
  // Strip characters invalid in most file systems
  let stripped = name.replace(/[<>:"/\\|?*]/g, '_');
  // Trim spaces and dots
  return stripped.trim().replace(/\.$/, "");
}
