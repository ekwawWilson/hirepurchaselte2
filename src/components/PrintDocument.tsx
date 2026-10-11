'use client';

import Link from 'next/link';
import { ArrowLeft, MessageCircle, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ReportLetterhead } from '@/components/ReportLetterhead';
import { whatsappNumber } from '@/lib/contractDocuments';

/**
 * The frame every printable document shares: a toolbar that stays on screen
 * (back, print, send by WhatsApp) and a sheet that is all that reaches the
 * paper — or the PDF, which is what "Save as PDF" in the print dialog makes.
 */
export function PrintDocument({ backHref, title, subtitle, share, children }: {
  backHref: string; title: string; subtitle?: string;
  /** A short text version to send to the customer's WhatsApp — the PDF itself is attached by hand. */
  share?: { phone: string | null; text: string };
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft className="h-4 w-4" /> Back to contract
        </Link>
        <div className="flex gap-2">
          {share?.phone && (
            <a
              href={`https://wa.me/${whatsappNumber(share.phone)}?text=${encodeURIComponent(share.text)}`} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <MessageCircle className="h-4 w-4" /> Send summary on WhatsApp
            </a>
          )}
          <Button onClick={() => window.print()}><Printer className="mr-1.5 h-4 w-4" /> Print / Save as PDF</Button>
        </div>
      </div>

      <div className="print-paper rounded-xl border border-gray-200 bg-white p-6 sm:p-10 text-gray-900">
        <ReportLetterhead />
        <div className="mt-4 mb-6">
          <h1 className="text-xl font-bold">{title}</h1>
          {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** A label over a value — the building block of each document's detail grids. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-sm text-gray-900 break-words">{children || '—'}</p>
    </div>
  );
}
