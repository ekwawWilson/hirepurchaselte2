"use client";

// Ported from the legacy hirepurchase app's own InstallAppButton. Browsers only
// offer installation over HTTPS (or localhost), so on a plain-HTTP deployment
// this renders nothing until the site has a certificate.

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isIosSafari() {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return isIos && isSafari;
}

function isStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

// The button floats over the page, so on a phone it can sit on top of a form
// field. Hiding it is remembered for a while on this device, and the browser's
// own menu can still install the app in the meantime.
const DISMISS_KEY = "hplite.installAppDismissedAt";
const DISMISS_DAYS = 30;

function dismissedRecently() {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY));
    return at > 0 && Date.now() - at < DISMISS_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

function HideButton({ onHide }: { onHide: () => void }) {
  return (
    <Button
      variant="outline"
      size="icon"
      className="h-8 w-8 bg-white"
      aria-label="Hide install button"
      onClick={() => {
        try {
          localStorage.setItem(DISMISS_KEY, String(Date.now()));
        } catch {
          // Storage unavailable (private mode): hide for this visit only.
        }
        onHide();
      }}
    >
      <X />
    </Button>
  );
}

export function InstallAppButton() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [showIosHint, setShowIosHint] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (dismissedRecently()) setHidden(true);
    if (isStandalone()) {
      setInstalled(true);
      return;
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  if (installed || hidden) return null;

  if (!deferredPrompt) {
    if (!isIosSafari()) return null;

    return (
      <>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" className="bg-white" onClick={() => setShowIosHint(true)}>
            <Download />
            Install App
          </Button>
          <HideButton onHide={() => setHidden(true)} />
        </div>
        {showIosHint && (
          <div
            role="dialog"
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
            onClick={() => setShowIosHint(false)}
          >
            <div
              className="w-full max-w-sm rounded-xl bg-white p-5 text-sm shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="mb-3 font-semibold">Install this app</p>
              <p className="text-muted-foreground">
                Tap the Share icon in Safari, then choose{" "}
                <span className="font-medium text-foreground">&quot;Add to Home Screen&quot;</span>.
              </p>
              <Button className="mt-4 w-full" size="sm" onClick={() => setShowIosHint(false)}>
                Got it
              </Button>
            </div>
          </div>
        )}
      </>
    );
  }

  const handleInstallClick = async () => {
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      setInstalled(true);
    }
    setDeferredPrompt(null);
  };

  return (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="sm" className="bg-white" onClick={handleInstallClick}>
        <Download />
        Install App
      </Button>
      <HideButton onHide={() => setHidden(true)} />
    </div>
  );
}
