'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, RefreshCw, UserRound, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import {
  CUSTOMER_PHOTO_WIDTH, CUSTOMER_PHOTO_HEIGHT, CUSTOMER_PHOTO_JPEG_QUALITY,
} from '@/lib/constants/customers';

/**
 * Crops a picture to passport proportions (7:9, centred) and shrinks it to
 * CUSTOMER_PHOTO_WIDTH x HEIGHT as a JPEG — done here, in the browser, so a
 * multi-megabyte photo is never uploaded or stored. Takes either a loaded
 * image or a live camera frame.
 */
function toPassportJpeg(source: HTMLImageElement | HTMLVideoElement): string {
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;

  const target = CUSTOMER_PHOTO_WIDTH / CUSTOMER_PHOTO_HEIGHT;
  let sw = width;
  let sh = height;
  if (width / height > target) sw = Math.round(sh * target); // too wide: trim the sides
  else sh = Math.round(sw / target); // too tall: trim top and bottom
  const sx = Math.round((width - sw) / 2);
  // Faces sit in the upper part of a portrait; keep a little more of the top.
  const sy = Math.round((height - sh) * 0.35);

  const canvas = document.createElement('canvas');
  canvas.width = CUSTOMER_PHOTO_WIDTH;
  canvas.height = CUSTOMER_PHOTO_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot process pictures');
  ctx.fillStyle = '#ffffff'; // a transparent PNG would otherwise turn black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', CUSTOMER_PHOTO_JPEG_QUALITY);
}

async function fileToPassportJpeg(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That file is not a picture this browser can read'));
      el.src = url;
    });
    return toPassportJpeg(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Live camera access exists only on a secure (HTTPS or localhost) page. */
function canUseLiveCamera() {
  return typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * A live camera preview with a passport-shaped guide and a Capture button —
 * the photo is taken, never browsed for.
 */
function CameraDialog({ open, onClose, onCapture }: {
  open: boolean;
  onClose: () => void;
  onCapture: (dataUrl: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Front camera first: at a desk the customer usually faces the screen.
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setReady(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => undefined);
        }
      })
      .catch((e: unknown) => {
        const name = e instanceof DOMException ? e.name : '';
        setError(
          name === 'NotAllowedError' ? 'Camera permission was refused. Allow camera access for this site in the browser settings, then try again.'
            : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No camera was found on this device.'
              : name === 'NotReadableError' ? 'The camera is being used by another application.'
                : 'The camera could not be started.',
        );
      });

    return () => { cancelled = true; stop(); };
  }, [open, facingMode, stop]);

  function capture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    onCapture(toPassportJpeg(video));
    stop();
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { stop(); onClose(); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Take customer photo</DialogTitle>
          <DialogDescription>Head and shoulders inside the frame, facing the camera.</DialogDescription>
        </DialogHeader>

        <div className="relative mx-auto w-full max-w-[280px] aspect-[7/9] overflow-hidden rounded-xl bg-slate-900">
          {error ? (
            <div className="absolute inset-0 flex items-center justify-center p-5 text-center text-sm text-white/80">{error}</div>
          ) : (
            <>
              <video
                ref={videoRef}
                playsInline
                muted
                onLoadedData={() => setReady(true)}
                // Mirror the front camera so it moves like a mirror; the saved photo is not mirrored.
                className={`h-full w-full object-cover ${facingMode === 'user' ? '-scale-x-100' : ''}`}
              />
              {/* Passport guide: an oval where the face should sit. */}
              <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-[12%]">
                <div className="h-[58%] w-[62%] rounded-[50%] border-2 border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]" />
              </div>
              {!ready && <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">Starting camera…</div>}
            </>
          )}
        </div>

        <DialogFooter className="flex-row justify-between gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => { stop(); setFacingMode((m) => (m === 'user' ? 'environment' : 'user')); }}
            disabled={!!error && !error.startsWith('No camera')}
          >
            <RefreshCw /> Switch camera
          </Button>
          <Button type="button" onClick={capture} disabled={!ready || !!error}>
            <Camera /> Capture
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CustomerPhotoField({
  value, onChange, required,
}: {
  value: string;
  onChange: (dataUrl: string) => void;
  required?: boolean;
}) {
  const fallbackCameraRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function takePhoto() {
    setError(null);
    if (canUseLiveCamera()) {
      setCameraOpen(true);
      return;
    }
    // On a plain-HTTP page the browser withholds live camera access. A phone
    // still honours `capture` and opens its camera app; a computer would
    // silently open a file browser instead, so say why rather than do that.
    if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      fallbackCameraRef.current?.click();
    } else {
      setError('The camera only works when the site is opened over a secure (https://) address. Use Upload for now.');
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // choosing the same file again should still fire
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      onChange(await fileToPassportJpeg(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not use that picture');
    } finally {
      setBusy(false);
    }
  }

  const sizeKb = value ? Math.round((value.length * 3) / 4 / 1024) : 0;

  return (
    <div>
      <Label>Customer photo{required ? '' : ' (optional)'}</Label>
      <div className="mt-1.5 flex items-center gap-4">
        <div className="relative w-[105px] h-[135px] shrink-0 overflow-hidden rounded-lg border border-dashed border-gray-300 bg-gray-50 flex items-center justify-center">
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data URL; next/image adds nothing here
            <img src={value} alt="Customer" className="h-full w-full object-cover" />
          ) : (
            <UserRound className="h-10 w-10 text-gray-300" />
          )}
          {value && (
            <button
              type="button"
              onClick={() => onChange('')}
              className="absolute top-1 right-1 rounded-full bg-black/55 p-0.5 text-white hover:bg-black/75"
              aria-label="Remove photo"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="space-y-2 min-w-0">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={takePhoto}>
              <Camera /> {value ? 'Retake photo' : 'Take photo'}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => uploadRef.current?.click()}>
              <ImagePlus /> Upload
            </Button>
          </div>
          <p className="text-xs text-gray-500">
            {busy ? 'Processing…' : value ? `Passport size, ${sizeKb} KB` : 'Head and shoulders, facing the camera. Resized to passport size automatically.'}
          </p>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      </div>

      <CameraDialog open={cameraOpen} onClose={() => setCameraOpen(false)} onCapture={onChange} />
      {/* Only used on a phone when live camera access is unavailable (plain HTTP). */}
      <input ref={fallbackCameraRef} type="file" accept="image/*" capture="user" className="hidden" onChange={onFile} />
      <input ref={uploadRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
    </div>
  );
}
