'use client';

import { useRef, useState } from 'react';
import { Camera, ImagePlus, UserRound, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  CUSTOMER_PHOTO_WIDTH, CUSTOMER_PHOTO_HEIGHT, CUSTOMER_PHOTO_JPEG_QUALITY,
} from '@/lib/constants/customers';

/**
 * Crops a picture to passport proportions (7:9, centred) and shrinks it to
 * CUSTOMER_PHOTO_WIDTH x HEIGHT as a JPEG — done here, in the browser, so a
 * multi-megabyte phone photo is never uploaded or stored.
 */
async function toPassportJpeg(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That file is not a picture this browser can read'));
      el.src = url;
    });

    const target = CUSTOMER_PHOTO_WIDTH / CUSTOMER_PHOTO_HEIGHT;
    const source = img.naturalWidth / img.naturalHeight;
    let sw = img.naturalWidth;
    let sh = img.naturalHeight;
    if (source > target) sw = Math.round(sh * target); // too wide: trim the sides
    else sh = Math.round(sw / target); // too tall: trim top and bottom
    const sx = Math.round((img.naturalWidth - sw) / 2);
    // Faces sit in the upper part of a portrait; keep a little more of the top.
    const sy = Math.round((img.naturalHeight - sh) * 0.35);

    const canvas = document.createElement('canvas');
    canvas.width = CUSTOMER_PHOTO_WIDTH;
    canvas.height = CUSTOMER_PHOTO_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot process pictures');
    ctx.fillStyle = '#ffffff'; // a transparent PNG would otherwise turn black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', CUSTOMER_PHOTO_JPEG_QUALITY);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function CustomerPhotoField({
  value, onChange, required,
}: {
  value: string;
  onChange: (dataUrl: string) => void;
  required?: boolean;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // choosing the same file again should still fire
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      onChange(await toPassportJpeg(file));
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
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => cameraRef.current?.click()}>
              <Camera /> Take photo
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
      {/* capture opens the camera directly on phones; the second input allows a saved picture. */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFile} />
      <input ref={uploadRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
    </div>
  );
}
