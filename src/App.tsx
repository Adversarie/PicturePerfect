import { useState, useEffect } from 'react';
import { useFileSystem } from './hooks/useFileSystem';
import { computePreviews } from './lib/renamer';
import { licenseClient, LicenseStatus, isDemoKeyAllowed } from './lib/license';
import { AlertCircle, FileAudio, FileImage, FileVideo, HardDrive, Play, RefreshCw, FolderOpen, Save, Settings2, Trash2, RotateCcw, CheckCircle2, Download, Zap, X, Crown, Lock, ExternalLink, Laptop, ShieldCheck } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from './lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import JSZip from 'jszip';

const DEFAULT_TEMPLATE = '{YYYY}-{MM}-{DD}_{HH}-{mm}-{ss}_{Model}';

export default function App() {
  const { scanDirectory, files, setFiles, isScanning, dirHandle, errorDetails, setErrorDetails, isFallbackMode } = useFileSystem();
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [renameMode, setRenameMode] = useState<'all' | 'batch'>('all');
  const [batchSize, setBatchSize] = useState(10);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isPro, setIsPro] = useState(false);
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [licenseKey, setLicenseKey] = useState('');
  const [isValidatingLicense, setIsValidatingLicense] = useState(false);
  const [licenseFeedback, setLicenseFeedback] = useState<{ message: string; isError: boolean } | null>(null);

  // Initialize and load cached license on mount
  useEffect(() => {
    licenseClient.init().then(() => {
      const status = licenseClient.getStatus();
      setLicenseStatus(status);
      setIsPro(status.valid);
    });
  }, []);

  // Update previews when template changes or files change
  useEffect(() => {
    if (files.length > 0 && !isProcessing && !isScanning) {
      setFiles((current) => computePreviews(current, template));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, files.length, isScanning]); 

  const handleExecuteRename = async () => {
    if (!dirHandle) return;
    setIsProcessing(true);
    setProgress(0);

    const pendingFiles = files.filter(f => f.status !== 'success' && f.file.name !== f.newNamePreview && !f.isDuplicate);
    let limit = renameMode === 'all' ? pendingFiles.length : batchSize;
    if (!isPro) limit = Math.min(20, limit);
    
    const filesToProcess = pendingFiles.slice(0, limit);
    
    let completed = 0;
    const newFiles = [...files];

    for (let i = 0; i < filesToProcess.length; i++) {
      const itemToProcess = filesToProcess[i];
      const itemIndex = newFiles.findIndex(f => (f.handle ? f.handle.name === itemToProcess.handle?.name : f.originalName === itemToProcess.originalName));
      if (itemIndex === -1) continue;
      
      const item = newFiles[itemIndex];

      if (item.status === 'success' || item.file.name === item.newNamePreview) {
        completed++;
        setProgress(Math.round((completed / filesToProcess.length) * 100));
        continue;
      }

      try {
        if (isFallbackMode) {
          // JSZip logic handled below, just mark success here
          item.status = 'success';
        } else if (dirHandle && item.handle) {
          // Modern File System API rename
          if ('move' in item.handle && typeof item.handle.move === 'function') {
            // @ts-ignore - TS dom types are sometimes behind the actual Chromium Support
            await item.handle.move(item.newNamePreview);
          } else {
            // Fallback: Copy via stream & remove old
            const newFileHandle = await dirHandle.getFileHandle(item.newNamePreview, { create: true });
            const writable = await newFileHandle.createWritable();
            const sourceFile = await item.handle.getFile();
            // Stream piping is highly memory efficient
            await sourceFile.stream().pipeTo(writable);
            await dirHandle.removeEntry(item.handle.name);
            
            item.handle = newFileHandle; 
          }
          item.status = 'success';
        }
      } catch (err: any) {
        console.error(`Error renaming ${item.file.name}:`, err);
        item.status = 'error';
        item.errorMessage = err.message || 'Failed';
      }

      completed++;
      setProgress(Math.round((completed / filesToProcess.length) * 100));
      setFiles([...newFiles]); // Re-render progress
    }

    if (isFallbackMode) {
      try {
        const zip = new JSZip();
        // Add only successfully renamed files to the zip
        filesToProcess.forEach(f => {
           if (f.status === 'success') {
             zip.file(f.newNamePreview, f.file);
           }
        });
        const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `PicturePerfect_Preview_Renamed_${format(new Date(), 'HHmmss')}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) {
        console.error("ZIP Generation failed:", e);
      }
    }

    setIsProcessing(false);
  };

  const handleUndo = async () => {
    if (!dirHandle && !isFallbackMode) return;
    setIsProcessing(true);
    setProgress(0);

    const successfullyRenamed = files.filter(f => f.status === 'success');
    let completed = 0;
    const newFiles = [...files];

    for (let i = 0; i < successfullyRenamed.length; i++) {
        const itemToProcess = successfullyRenamed[i];
        const itemIndex = newFiles.findIndex(f => (f.handle ? f.handle.name === itemToProcess.handle?.name : f.originalName === itemToProcess.originalName));
        if (itemIndex === -1) continue;
        
        const item = newFiles[itemIndex];

        try {
          if (isFallbackMode) {
            item.status = 'pending';
            item.newNamePreview = item.originalName;
          } else if (dirHandle && item.handle) {
            // Rename back using Modern API
            if ('move' in item.handle && typeof item.handle.move === 'function') {
              // @ts-ignore
              await item.handle.move(item.originalName);
            } else {
              // Fallback
              const newFileHandle = await dirHandle.getFileHandle(item.originalName, { create: true });
              const writable = await newFileHandle.createWritable();
              const sourceFile = await item.handle.getFile();
              await sourceFile.stream().pipeTo(writable);
              await dirHandle.removeEntry(item.handle.name);
              
              item.handle = newFileHandle; 
            }
            item.status = 'pending';
            item.newNamePreview = item.originalName;
          }
        } catch (err: any) {
          console.error(`Error undoing ${item.file.name}:`, err);
          item.status = 'error';
          item.errorMessage = 'Undo failed: ' + (err.message || 'Unknown');
        }

        completed++;
        setProgress(Math.round((completed / successfullyRenamed.length) * 100));
        setFiles([...newFiles]);
    }

    // Trigger preview recalculation
    setFiles((current) => computePreviews(current, template));
    setIsProcessing(false);
  };

  const handleExportCSV = () => {
    if (files.length === 0) return;

    const headers = ["Original Name", "New Name", "Status", "Date Taken", "Location"];
    const rows = files.map(f => {
      const dateTaken = f.metadata?.dateTaken ? format(f.metadata.dateTaken, 'yyyy-MM-dd HH:mm:ss') : 'Unknown';
      const city = f.metadata?.location?.city || 'Unknown';
      
      const escapeStr = (str: string) => `"${str.replace(/"/g, '""')}"`;
      
      return [
        escapeStr(f.file.name),
        escapeStr(f.status === 'success' ? f.newNamePreview : ""),
        escapeStr(f.status),
        escapeStr(dateTaken),
        escapeStr(city)
      ].join(",");
    });

    const csvContent = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `PicturePerfect_Export_${format(new Date(), 'yyyyMMdd_HHmmss')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const getFileIcon = (ext: string, isIPhone: boolean) => {
    const e = ext.toLowerCase();
    if (e === 'mov' || e === 'mp4') return <FileVideo className={cn("w-5 h-5", isIPhone ? "text-blue-400" : "text-neutral-500")} />;
    return <FileImage className={cn("w-5 h-5", isIPhone ? "text-amber-400" : "text-neutral-500")} />;
  };

  const handleActivate = async () => {
    if (!licenseKey.trim()) {
      setLicenseFeedback({ message: 'Please enter a valid license key.', isError: true });
      return;
    }
    setIsValidatingLicense(true);
    setLicenseFeedback(null);
    try {
      const res = await licenseClient.activate(licenseKey);
      setIsValidatingLicense(false);
      if (res.success) {
        setIsPro(true);
        setLicenseStatus(res.status);
        setLicenseFeedback({ message: res.message || 'License activated successfully!', isError: false });
        setTimeout(() => {
          setShowUpgradeModal(false);
          setLicenseKey('');
        }, 1200);
      } else {
        setLicenseFeedback({ message: res.message || 'Activation failed. Please check your key.', isError: true });
      }
    } catch {
      setIsValidatingLicense(false);
      setLicenseFeedback({ message: 'Network error connecting to activation server.', isError: true });
    }
  };

  const handleDeactivate = async () => {
    if (!confirm('Are you sure you want to unlink this workstation? This will release 1 of your 2 device seats on Lemon Squeezy.')) {
      return;
    }
    setIsValidatingLicense(true);
    try {
      const res = await licenseClient.deactivate();
      setIsValidatingLicense(false);
      setIsPro(false);
      setLicenseStatus(res.status);
      setLicenseFeedback({ message: res.message || 'Device seat unlinked.', isError: false });
      setTimeout(() => {
        setShowUpgradeModal(false);
      }, 1200);
    } catch {
      setIsValidatingLicense(false);
      setLicenseFeedback({ message: 'Error deactivating license.', isError: true });
    }
  };

  return (
    <div className="flex h-screen w-full bg-neutral-950 text-neutral-200 overflow-hidden">
      
      {/* Sidebar: Settings */}
      <div className="w-80 border-r border-neutral-800 bg-neutral-900/50 flex flex-col pt-8">
         <div className="px-6 pb-6 border-b border-neutral-800 flex items-start justify-between">
            <div>
               <h1 className="text-xl font-semibold tracking-tight text-white flex items-center gap-2">
                 <HardDrive className="w-5 h-5 text-rose-500" />
                 Picture Perfect
               </h1>
               <p className="text-xs text-neutral-500 mt-2">iPhone &amp; Camera Media Renamer</p>
            </div>
            {!isPro && (
               <button 
                  onClick={() => {
                    setLicenseFeedback(null);
                    setLicenseStatus(licenseClient.getStatus());
                    setShowUpgradeModal(true);
                  }}
                  className="bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 px-2 py-1 rounded text-xs font-medium flex items-center gap-1.5 transition-colors border border-rose-500/20 cursor-pointer"
               >
                 <Zap className="w-3.5 h-3.5" />
                 Upgrade
               </button>
            )}
            {isPro && (
               <button
                 onClick={() => {
                   setLicenseFeedback(null);
                   setLicenseStatus(licenseClient.getStatus());
                   setShowUpgradeModal(true);
                 }}
                 className="bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1.5 border border-amber-500/20 cursor-pointer transition-colors"
                 title="Manage Subscription & License"
               >
                 <Crown className="w-3.5 h-3.5" />
                 {licenseStatus?.state === 'LICENSED_OFFLINE_GRACE' ? `PRO (${licenseStatus.grace_days_left}d)` : 'PRO'}
               </button>
            )}
         </div>

         <div className="p-6 flex-1 overflow-y-auto">
            {/* Step 1 */}
            <div className="mb-8">
               <h2 className="text-xs uppercase tracking-wider text-neutral-500 font-semibold mb-3">1. Source Folder</h2>
               <button 
                  onClick={scanDirectory}
                  disabled={isScanning || isProcessing}
                  className="w-full flex items-center justify-center gap-2 bg-neutral-800 hover:bg-neutral-700 text-sm font-medium py-2.5 px-4 rounded-md transition-colors disabled:opacity-50"
                >
                  {isScanning ? (
                    <RefreshCw className="w-4 h-4 animate-spin text-neutral-400" />
                  ) : (
                    <FolderOpen className="w-4 h-4 text-neutral-400" />
                  )}
                  {dirHandle ? 'Rescan Directory' : 'Select Directory'}
               </button>
               {dirHandle && (
                 <p className="text-xs text-neutral-500 mt-3 truncate bg-neutral-950 px-3 py-2 rounded border border-neutral-800 font-mono">
                   /{dirHandle.name}
                 </p>
               )}
            </div>

            {/* Step 2 */}
            <div className="mb-8">
              <h2 className="text-xs uppercase tracking-wider text-neutral-500 font-semibold mb-3 flex items-center gap-2">
                 <Settings2 className="w-3.5 h-3.5" />
                 2. Rename Template
              </h2>
              
              <div className="space-y-4">
                 <div>
                   <label className="text-xs text-neutral-400 mb-1.5 block">Format Pattern</label>
                   <input 
                     value={template}
                     onChange={(e) => setTemplate(e.target.value)}
                     disabled={isProcessing}
                     className="w-full bg-neutral-950 border border-neutral-800 rounded-md px-3 py-2 text-sm font-mono text-rose-400 focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500 transition-colors"
                   />
                 </div>

                 <div className="bg-neutral-950/50 p-3 rounded-md border border-neutral-800">
                    <p className="text-[10px] text-neutral-500 uppercase font-semibold mb-2 tracking-wider">Available Tags</p>
                    <div className="grid grid-cols-2 gap-2 text-xs font-mono text-neutral-400">
                      <span>{'{YYYY}'}</span> <span>{'{HH}'}</span>
                      <span>{'{MM}'}</span> <span>{'{mm}'}</span>
                      <span>{'{DD}'}</span> <span>{'{ss}'}</span>
                      <span>{'{Model}'}</span> <span>{'{Original}'}</span>
                      <span className="col-span-2 text-teal-400">{'{City}'}</span>
                    </div>
                 </div>
              </div>
            </div>

            {/* Step 3 */}
            <div className="mb-8">
              <h2 className="text-xs uppercase tracking-wider text-neutral-500 font-semibold mb-3 flex items-center gap-2">
                 <Settings2 className="w-3.5 h-3.5" />
                 3. Execution Settings
              </h2>
              
              <div className="space-y-4">
                 <div>
                    <label className="text-xs text-neutral-400 mb-1.5 block">Rename Mode</label>
                     <div className="flex bg-neutral-950 p-1 rounded-md border border-neutral-800">
                      <button 
                         onClick={() => setRenameMode('all')}
                         className={cn("flex-1 text-xs py-1.5 rounded-sm transition-colors", renameMode === 'all' ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-300")}
                      >
                         All at Once
                      </button>
                      <button 
                         onClick={() => {
                           if (isPro) {
                             setRenameMode('batch');
                           } else {
                             setShowUpgradeModal(true);
                           }
                         }}
                         className={cn("flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 rounded-sm transition-colors", renameMode === 'batch' ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-300")}
                      >
                         Batched
                         {!isPro && <Lock className="w-3 h-3 text-neutral-600" />}
                      </button>
                    </div>
                 </div>

                 <AnimatePresence>
                   {renameMode === 'batch' && (
                      <motion.div 
                        initial={{ opacity: 0, height: 0 }} 
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="pt-2">
                          <label className="text-xs text-neutral-400 mb-2 flex justify-between">
                             Batch Size: <span className="text-white font-mono">{batchSize} files</span>
                          </label>
                          <input 
                             type="range"
                             min="1"
                             max="100"
                             value={batchSize}
                             onChange={(e) => setBatchSize(parseInt(e.target.value))}
                             className="w-full accent-rose-500"
                          />
                        </div>
                      </motion.div>
                   )}
                 </AnimatePresence>
              </div>
            </div>
         </div>

         {/* Step 4 Action */}
         <div className="p-6 border-t border-neutral-800 bg-neutral-900">
           {(() => {
              const pendingCount = files.filter(f => f.status !== 'success' && f.file.name !== f.newNamePreview && !f.isDuplicate).length;
              const buttonDisabled = pendingCount === 0 || isProcessing || isScanning;
              let amount = renameMode === 'all' ? pendingCount : Math.min(batchSize, pendingCount);
              if (!isPro) amount = Math.min(20, amount);
              
              const undoCount = files.filter(f => f.status === 'success').length;
              
              return (
                 <div className="flex flex-col gap-3">
                   <button 
                      onClick={() => {
                        if (!isPro && pendingCount > 20) {
                           // They can still rename the first 20, but let's notify them that they are limited
                           // For simplicity, we just execute the 20, the modal can be triggered too.
                        }
                        handleExecuteRename();
                      }}
                      disabled={buttonDisabled}
                      className="w-full flex flex-col items-center justify-center gap-1 bg-rose-600 hover:bg-rose-500 text-white text-sm font-medium py-2 px-4 rounded-md shadow-lg shadow-rose-900/20 transition-all disabled:opacity-50 disabled:shadow-none min-h-[50px]"
                    >
                      {isProcessing ? (
                        <div className="flex items-center gap-2">
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          Processing ({progress}%)
                        </div>
                      ) : (
                        <div className="flex flex-col items-center">
                           <div className="flex items-center gap-2">
                             <Play className="w-4 h-4 fill-white flex-shrink-0" />
                             {renameMode === 'batch' ? `Execute Batch (${amount})` : `Execute All (${amount})`}
                           </div>
                           {!isPro && pendingCount > 20 && (
                             <span className="text-[10px] text-rose-200 mt-0.5">Free limit: 20 per scan</span>
                           )}
                        </div>
                      )}
                   </button>

                   {undoCount > 0 && (
                     <button
                        onClick={() => {
                          if (isPro) {
                            handleUndo();
                          } else {
                            setShowUpgradeModal(true);
                          }
                        }}
                        disabled={isProcessing}
                        className="w-full flex items-center justify-center gap-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm font-medium py-2.5 px-4 rounded-md transition-all disabled:opacity-50 relative overflow-hidden"
                     >
                        <RotateCcw className="w-4 h-4" />
                        Undo {undoCount} Rename{undoCount !== 1 ? 's' : ''}
                        {!isPro && <Lock className="w-3.5 h-3.5 text-neutral-500 absolute right-4" />}
                     </button>
                   )}

                   {files.length > 0 && (
                      <button
                         onClick={() => {
                           if (isPro) {
                             handleExportCSV();
                           } else {
                             setShowUpgradeModal(true);
                           }
                         }}
                         disabled={isProcessing}
                         className="w-full flex items-center justify-center gap-2 border border-neutral-700 hover:bg-neutral-800 text-neutral-300 text-sm font-medium py-2.5 px-4 rounded-md transition-all disabled:opacity-50 relative overflow-hidden"
                      >
                         <Download className="w-4 h-4" />
                         Export CSV Logging
                         {!isPro && <Lock className="w-3.5 h-3.5 text-neutral-500 absolute right-4" />}
                      </button>
                   )}
                 </div>
              );
           })()}
         </div>
      </div>

      {/* Main Area: Preview */}
      <div className="flex-1 bg-neutral-950 flex flex-col">
        {files.length === 0 && !isScanning ? (
           <div className="flex-1 flex flex-col items-center justify-center px-8 text-center bg-neutral-950 overflow-y-auto pt-10 pb-10">
              <div className="bg-neutral-900/50 border border-neutral-800 rounded-xl p-8 max-w-lg w-full shadow-2xl relative">
                 {errorDetails && (
                   <div className="absolute top-0 left-0 right-0 -translate-y-[calc(100%+16px)] bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-lg text-sm flex items-start gap-3 text-left">
                     <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                     <div className="flex-1">
                       <p className="font-semibold mb-1">Access Failed</p>
                       <p>{errorDetails}</p>
                     </div>
                     <button onClick={() => setErrorDetails(null)} className="p-1 hover:bg-red-500/20 rounded-md transition-colors"><X className="w-4 h-4" /></button>
                   </div>
                 )}
                 <HardDrive className="w-12 h-12 text-rose-500 mb-4 mx-auto drop-shadow-[0_0_15px_rgba(244,63,94,0.3)]" />
                 <h3 className="text-xl font-medium text-white mb-2">Ready to scan your media</h3>
                 <p className="text-sm text-neutral-400 mb-8">
                   Select a folder to extract EXIF data, reverse-geocode locations, and rename everything with a unified convention.
                 </p>
                 
                 <div className="text-left bg-neutral-950 border border-neutral-800 rounded-lg p-5">
                   <h4 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      What Picture Perfect Fixes
                   </h4>
                   <ul className="space-y-4 text-sm">
                     <li className="flex gap-3 items-start">
                       <div className="w-1.5 h-1.5 rounded-full bg-rose-500 mt-1.5 shrink-0" />
                       <p><strong className="text-neutral-200 font-medium">Fixes FullSizeRender.jpg</strong><br/><span className="text-neutral-500 text-xs">Replaces generic names with actual dates</span></p>
                     </li>
                     <li className="flex gap-3 items-start">
                       <div className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-1.5 shrink-0" />
                       <p><strong className="text-neutral-200 font-medium">Renames IMG_E1234.JPG</strong><br/><span className="text-neutral-500 text-xs">Handles Apple's hidden edit files cleanly</span></p>
                     </li>
                     <li className="flex gap-3 items-start">
                       <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 mt-1.5 shrink-0" />
                       <p><strong className="text-neutral-200 font-medium">Translates WhatsApp files</strong><br/><span className="text-neutral-500 text-xs">e.g., BWFS6446.JPG becomes easily sortable</span></p>
                     </li>
                     <li className="flex gap-3 items-start">
                       <div className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-1.5 shrink-0" />
                       <p><strong className="text-neutral-200 font-medium">Sorts the DCIM folder chaos</strong><br/><span className="text-neutral-500 text-xs">Unifies all scattered media under one convention</span></p>
                     </li>
                   </ul>
                 </div>
              </div>
           </div>
        ) : isScanning ? (
           <div className="flex-1 flex flex-col items-center justify-center">
              <RefreshCw className="w-8 h-8 text-rose-500 animate-spin mb-4" />
              <h3 className="text-lg font-medium text-neutral-300">Scanning Media Files</h3>
              <p className="text-sm text-neutral-500 mt-2">Extracting EXIF data...</p>
           </div>
        ) : (
           <div className="flex-1 flex flex-col">
             <div className="px-8 py-5 border-b border-neutral-900 flex items-center justify-between">
                <div>
                   <h2 className="text-lg font-medium text-white">Preview Changes</h2>
                   <p className="text-sm text-neutral-500 mt-1">Found {files.length} valid media files.</p>
                </div>
             </div>

             <div className="flex-1 overflow-auto relative">
                <table className="w-full text-left text-sm border-collapse">
                   <thead className="sticky top-0 bg-neutral-950/90 backdrop-blur border-b border-neutral-900 text-neutral-500 z-10 text-xs uppercase tracking-wider font-semibold">
                      <tr>
                        <th className="py-4 px-8 font-medium">Original File</th>
                        <th className="py-4 px-6 font-medium text-center">Metadata</th>
                        <th className="py-4 px-8 font-medium">Target Filename</th>
                      </tr>
                   </thead>
                   <tbody className="divide-y divide-neutral-900">
                     <AnimatePresence>
                      {files.map((item, idx) => {
                         const metadata = item.metadata;
                         
                         return (
                           <motion.tr 
                             initial={{ opacity: 0, y: 5 }} 
                             animate={{ opacity: 1, y: 0 }} 
                             transition={{ delay: Math.min(idx * 0.02, 0.5) }}
                             key={(item.handle?.name || item.file.name) + idx} 
                             className="hover:bg-neutral-900/30 transition-colors group"
                            >
                              <td className="py-3 px-8 text-neutral-400 font-mono text-xs flex items-center gap-3">
                                 {getFileIcon(item.handle?.name || item.file.name, metadata?.isIPhone || false)}
                                 <span className="truncate max-w-[200px]" title={item.file.name}>{item.file.name}</span>
                                 {item.isDuplicate && (
                                    <span className="bg-rose-500/20 text-rose-400 border border-rose-500/30 px-1.5 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider ml-2">Duplicate</span>
                                 )}
                              </td>
                              
                              <td className="py-3 px-6 text-center">
                                 <div className="flex flex-col items-center gap-1">
                                   {metadata?.dateTaken ? (
                                     <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-neutral-900 text-neutral-300 text-xs border border-neutral-800">
                                        {format(metadata.dateTaken, 'yyyy-MM-dd')}
                                        {metadata.isIPhone && (
                                          <div className="w-1.5 h-1.5 rounded-full bg-amber-400 ml-1 shadow-[0_0_8px_rgba(251,191,36,0.5)]" title="Apple Device Detected" />
                                        )}
                                     </div>
                                   ) : (
                                     <span className="text-neutral-600 text-xs italic">Missing EXIF Date</span>
                                   )}
                                   {metadata?.location?.city && (
                                     <span className="text-teal-500/80 text-[10px] tracking-wide font-medium">
                                       {metadata.location.city}
                                     </span>
                                   )}
                                 </div>
                              </td>

                              <td className="py-3 px-8 font-mono text-xs">
                                 <div className="flex items-center gap-3">
                                   {item.isDuplicate ? (
                                      <span className="text-neutral-600 line-through truncate max-w-[300px]" title="Skipped">Skipped (Duplicate)</span>
                                   ) : item.status === 'success' ? (
                                      <span className="text-emerald-400 truncate max-w-[300px]">{item.newNamePreview}</span>
                                   ) : item.status === 'error' ? (
                                      <div className="flex items-center gap-2 text-rose-500">
                                        <AlertCircle className="w-4 h-4" />
                                        <span className="truncate max-w-[250px]" title={item.errorMessage}>{item.errorMessage}</span>
                                      </div>
                                   ) : (
                                      <span className={cn(
                                        "truncate max-w-[300px]", 
                                        item.newNamePreview === item.file.name ? "text-neutral-500" : "text-white"
                                      )}>
                                        {item.newNamePreview}
                                      </span>
                                   )}
                                 </div>
                              </td>
                           </motion.tr>
                         );
                      })}
                     </AnimatePresence>
                   </tbody>
                </table>
             </div>
           </div>
        )}
      </div>

      <AnimatePresence>
         {showUpgradeModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center pt-20 pb-20 px-4">
              <motion.div 
                 initial={{ opacity: 0 }} 
                 animate={{ opacity: 1 }} 
                 exit={{ opacity: 0 }} 
                 className="absolute inset-0 bg-neutral-950/80 backdrop-blur-sm"
                 onClick={() => setShowUpgradeModal(false)}
              />
              
              <motion.div 
                 initial={{ opacity: 0, scale: 0.95, y: 20 }}
                 animate={{ opacity: 1, scale: 1, y: 0 }}
                 exit={{ opacity: 0, scale: 0.95, y: 20 }}
                 className="relative w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl overflow-hidden"
              >
                 <button 
                   onClick={() => setShowUpgradeModal(false)}
                   className="absolute top-4 right-4 text-neutral-500 hover:text-white transition-colors p-1 z-10"
                 >
                   <X className="w-5 h-5" />
                 </button>

                 {isPro && licenseStatus?.valid ? (
                   // --- Active License Management View ---
                   <div>
                     <div className="p-8 pb-6 text-center border-b border-neutral-800 bg-neutral-900/50">
                        <div className="w-14 h-14 bg-gradient-to-br from-amber-500 to-amber-600 rounded-xl mx-auto flex items-center justify-center mb-4 shadow-lg shadow-amber-500/20">
                          <Crown className="w-7 h-7 text-white" />
                        </div>
                        <h2 className="text-2xl font-semibold text-white mb-1">Picture Perfect PRO</h2>
                        <p className="text-neutral-400 text-xs">Workstation license is active and authorized.</p>
                     </div>

                     <div className="p-6 space-y-4">
                        <div className="bg-neutral-950 p-4 rounded-xl border border-neutral-800 space-y-2.5 text-xs">
                          <div className="flex justify-between items-center">
                            <span className="text-neutral-400">Subscription Plan:</span>
                            <span className="font-semibold text-amber-400">{licenseStatus.plan}</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-neutral-400">License Status:</span>
                            <span className={cn("font-semibold flex items-center gap-1", licenseStatus.state === 'LICENSED_OFFLINE_GRACE' ? "text-amber-400" : "text-emerald-400")}>
                              <ShieldCheck className="w-3.5 h-3.5" />
                              {licenseStatus.state === 'LICENSED_OFFLINE_GRACE' 
                                ? `Offline Grace (${licenseStatus.grace_days_left}d left)`
                                : 'Active (Online Validated)'}
                            </span>
                          </div>
                          {licenseStatus.key_masked && (
                            <div className="flex justify-between items-center">
                              <span className="text-neutral-400">Active Key:</span>
                              <span className="font-mono text-neutral-200">{licenseStatus.key_masked}</span>
                            </div>
                          )}
                          {licenseStatus.instance_id && (
                            <div className="flex justify-between items-center">
                              <span className="text-neutral-400">Device Slot:</span>
                              <span className="font-mono text-neutral-400 flex items-center gap-1">
                                <Laptop className="w-3.5 h-3.5" />
                                {licenseStatus.instance_id.slice(0, 8)}... (Seat 1 of 2)
                              </span>
                            </div>
                          )}
                        </div>

                        {licenseFeedback && (
                          <div className={cn("p-3 rounded-lg text-xs font-medium", licenseFeedback.isError ? "bg-rose-500/10 text-rose-400 border border-rose-500/20" : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20")}>
                            {licenseFeedback.message}
                          </div>
                        )}

                        <div className="space-y-2 pt-2">
                          <button
                            onClick={() => licenseClient.openCustomerPortal()}
                            className="w-full bg-neutral-800 hover:bg-neutral-700 text-white font-medium py-2.5 px-4 rounded-xl transition-colors text-xs flex items-center justify-center gap-2"
                          >
                            <span>Manage Orders on Lemon Squeezy</span>
                            <ExternalLink className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={handleDeactivate}
                            disabled={isValidatingLicense}
                            className="w-full bg-rose-950/30 hover:bg-rose-900/40 border border-rose-900/50 text-rose-400 font-medium py-2.5 px-4 rounded-xl transition-colors text-xs flex items-center justify-center gap-2 disabled:opacity-50"
                          >
                            {isValidatingLicense ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : "Unlink This Workstation Seat"}
                          </button>
                        </div>
                     </div>
                   </div>
                 ) : (
                   // --- Upgrade / Activation View ---
                   <div>
                     <div className="p-8 pb-6 text-center border-b border-neutral-800 bg-neutral-900/50">
                        <div className="w-14 h-14 bg-gradient-to-br from-rose-500 to-amber-500 rounded-xl mx-auto flex items-center justify-center mb-5 shadow-lg shadow-rose-500/20">
                          <Zap className="w-7 h-7 text-white" />
                        </div>
                        <h2 className="text-2xl font-semibold text-white mb-2">Upgrade to Picture Perfect PRO</h2>
                        <p className="text-neutral-400 text-sm">Unlock unlimited metadata extraction and in-place batch renaming for <strong className="text-white">$99/year</strong> (2 workstation seats).</p>
                     </div>

                     <div className="p-8">
                        <ul className="space-y-4 mb-8">
                           <li className="flex items-center gap-3 text-neutral-300">
                             <div className="w-5 h-5 rounded-full bg-emerald-500/10 flex items-center justify-center shrink-0">
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                             </div>
                             Unlimited file renaming per scan
                           </li>
                           <li className="flex items-center gap-3 text-neutral-300">
                             <div className="w-5 h-5 rounded-full bg-emerald-500/10 flex items-center justify-center shrink-0">
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                             </div>
                             Paced Batch Processing modes
                           </li>
                           <li className="flex items-center gap-3 text-neutral-300">
                             <div className="w-5 h-5 rounded-full bg-emerald-500/10 flex items-center justify-center shrink-0">
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                             </div>
                             One-click Undo across batches
                           </li>
                           <li className="flex items-center gap-3 text-neutral-300">
                             <div className="w-5 h-5 rounded-full bg-emerald-500/10 flex items-center justify-center shrink-0">
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                             </div>
                             CSV Logging &amp; Reporting
                           </li>
                        </ul>

                        <div className="space-y-3 mb-6 bg-neutral-950 p-4 rounded-xl border border-neutral-800">
                           <label className="text-xs font-semibold text-neutral-400 uppercase tracking-wider block">Activate License Key</label>
                           <div className="flex gap-2">
                             <input
                               type="text"
                               placeholder={isDemoKeyAllowed() ? "XXXX-XXXX-XXXX-XXXX or DEMO-KEY-123" : "XXXX-XXXX-XXXX-XXXX"}
                               value={licenseKey}
                               onChange={(e) => {
                                 setLicenseKey(e.target.value);
                                 setLicenseFeedback(null);
                               }}
                               onKeyDown={(e) => {
                                 if (e.key === 'Enter') handleActivate();
                               }}
                               className="flex-1 bg-neutral-900 border border-neutral-700 text-sm rounded-lg px-3 py-2 text-white placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500"
                             />
                             <button
                               onClick={handleActivate}
                               disabled={isValidatingLicense || !licenseKey.trim()}
                               className="bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors flex items-center justify-center shrink-0 min-w-[90px]"
                             >
                               {isValidatingLicense ? (
                                 <RefreshCw className="w-4 h-4 animate-spin" />
                               ) : (
                                 "Activate"
                               )}
                             </button>
                           </div>
                           {licenseFeedback && (
                             <p className={cn("text-xs mt-2", licenseFeedback.isError ? "text-rose-400" : "text-emerald-400")}>
                               {licenseFeedback.message}
                             </p>
                           )}
                        </div>

                        <button 
                           onClick={() => licenseClient.startCheckout('pro')}
                           className="w-full bg-white hover:bg-neutral-200 text-neutral-900 font-semibold py-3 px-4 rounded-xl transition-colors shadow-xl flex items-center justify-center gap-2"
                        >
                           <span>Get Picture Perfect Pro — $99/year</span>
                           <ExternalLink className="w-4 h-4" />
                        </button>
                        <p className="text-center text-xs text-neutral-500 mt-4">Secured by Lemon Squeezy Merchant of Record. Includes 2 workstation seats with 7-day offline grace.</p>
                     </div>
                   </div>
                 )}
              </motion.div>
            </div>
         )}
      </AnimatePresence>
    </div>
  );
}
