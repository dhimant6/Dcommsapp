# Dcom mobile (Expo React Native) — skeleton

The offline-first client: typed navigation (auth stack ⇄ main stack driven by the
Zustand store), phone+OTP screens wired to the gateway, a reconnecting WS manager
(jittered backoff + 30s heartbeat), and the SQLite cache implementing the
four-rule sync model (UI reads only SQLite; network writes into it; outbound
messages are 'pending' rows first; sync cursor = MAX(created_at) → `?since=`).

## Status

**Chat implemented, awaiting on-device verification.** The chat list and chat
room screens are real now: both render exclusively from SQLite (`db/chatRepo.ts`),
`sync/chatSync.ts` implements the four-rule sync model (REST `?since=` cursors,
optimistic 'pending' rows with reconnect replay, WS events upserting into the
DB), and receipts/ticks flow end-to-end. Typechecks clean; it has NOT yet been
exercised on a device/emulator — this repo's dev machine has neither. To run it:

1. `cd apps/mobile && npm install`
2. `npx expo start` → Expo Go on a phone on the same Wi-Fi
3. Set the gateway URL in `src/api/client.ts` to `http://<your-LAN-IP>:3000`
   (a phone's `localhost` is the phone itself; Android emulator: `adb reverse
   tcp:3000 tcp:3000`).

## Store deployment path (when the app is complete)

- **Android**: `eas build -p android` → Play Console → Internal testing track.
  Signing: EAS manages the keystore (or `eas credentials` to bring your own).
  Push: Firebase project + `google-services.json`.
- **iOS**: Apple Developer Program ($99/yr) → `eas build -p ios` (EAS manages
  provisioning profiles/certs) → TestFlight via `eas submit`. Permissions
  already declared in `app.json` (mic, camera, photos).
- CI: GitHub Actions runs `eas build --non-interactive` on tags — see
  `.github/workflows/` at the repo root.
