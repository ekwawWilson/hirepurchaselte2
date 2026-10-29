# FlezePay Customer (mobile app)

The customer app: see what is owed, pay it by Mobile Money in seconds, see payments, manage the password.
Expo SDK 58 (React Native 0.88), Expo Router, TypeScript. Android first; package `com.flezepay.customer`.

It talks to the same server as the web portal, through the customer API (`/api/portal/*`) and the public
`/api/settings` (company name, support phone, logo). The app holds no secrets: only the API address and the
customer's own sign-in token, kept in the encrypted SecureStore.

## Run it

```bash
cd mobile
npm install
npx expo start          # scan the QR code with Expo Go on an Android phone
```

The app uses the live server by default. To point it elsewhere, set `EXPO_PUBLIC_API_URL`
(for example `EXPO_PUBLIC_API_URL=http://192.168.1.20:3000/api npx expo start`), and use test customers
only, never real ones.

Checks, before any release:

```bash
npm run typecheck
npm run lint
npm test                # the "what is owed" arithmetic (tests/due.test.ts)
npx expo-doctor
```

## What it does

| Screen | |
|---|---|
| Sign in | Phone and password. "Forgot password?" texts a 6-digit code to the registered number. |
| Choose your password | After signing in with a temporary password from staff, before anything else. |
| Home | What is due now, the next payment, totals, the latest contracts, tap-to-call help. |
| Contracts | Every contract; each page has the terms and the schedule (To pay / Paid / All, paged), with Pay pinned at the bottom. |
| Pay (centre button) | The right amount already chosen, one-tap amounts, what the payment covers, the registered number to pay from, and an honest status until the server confirms. |
| Payments | Every payment by month, with receipts. |
| Profile | Details, change password, log out. |

Rules it follows, all enforced again by the server:
- A payment is never more than is owed. A device loan takes only the interest owed or the full loan amount;
  savings take any amount from GH₵ 1 to GH₵ 20,000.
- The prompt only goes to one of the customer's own registered numbers (a Hubtel requirement).
- "Covers …" follows the server's order: the deposit while owed, then late charges, then instalments oldest
  first.

## Deep link (PayTrigger lock screen)

`flezepay://pay?contract=<contract id>` opens Pay with that contract chosen. PayTrigger's lock screen can show
a pay button with this link; give PayTrigger **both** the link and the package `com.flezepay.customer`, or it
refuses the link (code 50012).

## Build an APK

```bash
scripts/build-apk.sh --bump     # every release: raise versionCode, then build
scripts/build-apk.sh            # rebuild the same version
```

This runs `./gradlew assembleRelease` in `android/` (generated from `app.json` by `expo prebuild`; never edit it
by hand) and writes `FlezePay-Customer-<version>-<versionCode>.apk` here. On first use it installs JDK 17 and the
Android SDK into `TOOLCHAIN_DIR` (default `~/android-toolchain`, about 8 GB) and creates the release upload key in
`KEYS_DIR` (default `~/flezepay-keys`). On the office machine both are on the data drive:

```bash
TOOLCHAIN_DIR=/run/media/wilsondeveloper/ubuntu/android-toolchain \
KEYS_DIR=/run/media/wilsondeveloper/ubuntu/flezepay-keys scripts/build-apk.sh --bump
```

Release builds are signed with that key (`plugins/withReleaseSigning.js`), never the debug key.

**Every release:**
1. Use `--bump`: Android, and any device-management tool, refuses an update whose `versionCode` isn't higher.
2. Keep `version` the same in `app.json`, `package.json` and `src/constants/config.ts`.
3. Sign with **the same key** every time, or the update won't install over the app already on phones.
   **Back up `KEYS_DIR`** somewhere safe outside this machine: losing it means customers must uninstall and
   reinstall. The script prints the key's SHA-256 fingerprint; device-management portals ask for it.

Building in the cloud instead: `npx eas-cli@latest build -p android --profile preview` (needs an Expo account,
and its own key unless this one is uploaded to EAS).

## Branding

The icon and splash come from the FlezePay logo (Settings in the web app): the "F" mark on black for the
icon, the full wordmark on black for the splash and sign-in screen (`assets/logo.png`). To change them, keep the
sizes: `icon.png` 1024×1024, `android-icon-foreground.png` 1024×1024 with the mark inside the middle half on a
transparent background, `splash-icon.png` 1024×1024 transparent. The in-app colour is in
`src/constants/colors.ts`.
