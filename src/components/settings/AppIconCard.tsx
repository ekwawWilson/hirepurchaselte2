'use client';

import { useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { APP_ICON_SIZE, MAX_APP_ICON_BYTES } from '@/lib/constants/branding';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

/**
 * Crops the chosen picture to a centred square and resizes it to
 * APP_ICON_SIZE. PNG keeps transparency; a photo-like image too large as PNG
 * is saved as JPEG instead.
 */
async function toSquareIcon(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That file is not a picture this browser can read'));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = APP_ICON_SIZE;
    canvas.height = APP_ICON_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot process pictures');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, APP_ICON_SIZE, APP_ICON_SIZE);

    const png = canvas.toDataURL('image/png');
    if ((png.length * 3) / 4 <= MAX_APP_ICON_BYTES) return png;
    // JPEG has no transparency: paint a white ground first.
    const flat = document.createElement('canvas');
    flat.width = flat.height = APP_ICON_SIZE;
    const fctx = flat.getContext('2d')!;
    fctx.fillStyle = '#ffffff';
    fctx.fillRect(0, 0, APP_ICON_SIZE, APP_ICON_SIZE);
    fctx.drawImage(canvas, 0, 0);
    return flat.toDataURL('image/jpeg', 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function AppIconCard({ companyName }: { companyName: string }) {
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  // Changes after every save, so the preview reloads the freshly rendered icon.
  const [version, setVersion] = useState(() => Date.now().toString(36));

  async function save(appIconUrl: string | null) {
    setSaving(true);
    try {
      const res = await api.patch<{ version: string }>('/settings/app-icon', { appIconUrl });
      setVersion(res.version);
      toast({
        title: appIconUrl ? 'App icon saved' : 'App icon removed',
        description: 'New installs use it straight away. An app already installed updates its icon when the phone next refreshes it, which can take a day.',
      });
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to save the app icon', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      await save(await toSquareIcon(file));
    } catch (err) {
      toast({ title: 'Could not use that picture', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
    }
  }

  const iconSrc = (file: string) => `/app-icon/${file}?v=${version}`;

  return (
    <Card>
      <CardHeader><CardTitle>App icon</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-gray-400">
          The icon on a phone&apos;s home screen and computer desktop when the app is installed, and in the browser tab.
          Upload a square picture (it is cropped to a square and resized to {APP_ICON_SIZE}×{APP_ICON_SIZE}). Without one,
          the company logo is used, and without a logo the company&apos;s initials.
        </p>

        <div className="flex flex-wrap items-end gap-6">
          {/* How it sits on a home screen */}
          <div className="rounded-2xl bg-gradient-to-br from-slate-700 to-slate-900 px-6 pt-5 pb-3 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- a dynamic route; next/image adds nothing here */}
            <img src={iconSrc('icon-192.png')} alt="App icon" width={64} height={64} className="mx-auto h-16 w-16 rounded-[14px]" />
            <p className="mt-1.5 max-w-[88px] truncate text-[11px] text-white">{companyName}</p>
          </div>
          <div className="text-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- a dynamic route; next/image adds nothing here */}
            <img src={iconSrc('icon-512-maskable.png')} alt="App icon as Android crops it" width={64} height={64} className="mx-auto h-16 w-16 rounded-full" />
            <p className="mt-1.5 text-[11px] text-gray-400">Android (round)</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => fileInput.current?.click()}>
            <ImagePlus /> {saving ? 'Saving…' : 'Upload icon'}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => save(null)}>
            <Trash2 /> Remove icon
          </Button>
        </div>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg" className="hidden" onChange={onFile} />
      </CardContent>
    </Card>
  );
}
