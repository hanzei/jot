# Jot Mobile

React Native / Expo app for Jot. See the repository [`README.md`](../README.md)
and [`CLAUDE.md`](./CLAUDE.md) for the broader project overview and conventions.

## Quick Capture

The app offers several low-friction ways to get from "I have a thought" to "it's
in Jot" without first navigating the notes list.

### App-icon quick actions

Long-pressing the Jot launcher icon exposes **New note** and **New list**
shortcuts (iOS Home Screen Quick Actions / Android app shortcuts, both provided
by [`expo-quick-actions`](https://github.com/EvanBacon/expo-quick-actions)).

- The items are registered at runtime in `useQuickActionRouting` so their labels
  follow the user's selected app language (`quickActions.*` i18n keys).
- Launching via a quick action deep-links straight into the note editor
  (`NoteEditor` with `noteId: null` and `initialNoteType`), skipping the notes
  list. **New list** starts the editor in checklist mode with the title focused.
- The editor creates an offline draft, so this path works with no network. If
  the app is launched cold and the user is not yet authenticated, the request is
  stashed (`store/quickAction.ts`) and replayed after login.

### Share-to-note (Android + iOS)

Sharing text (or a URL) from another app into Jot opens a prefilled new note.
This is handled by [`expo-share-intent`](https://github.com/achorein/expo-share-intent)
and wired through `useShareIntentNavigation`; multi-server users can redirect the
share to another server before it is saved.

#### iOS share extension — native build requirements

iOS share support was previously disabled (`disableIOS: true`) because, unlike
Android intent filters, an iOS share sheet entry requires a **separate native
Share Extension target** that cannot run in Expo Go and adds native/provisioning
overhead. It is now enabled via `iosActivationRules` in `app.json`. Because of
that, be aware when producing an iOS build:

- **A development/production build is required** (`npx expo prebuild` +
  `eas build`, or a local dev client). The share extension does not work in Expo
  Go.
- The `expo-share-intent` config plugin generates the extension target and an
  **App Group** entitlement (default `group.<bundleIdentifier>`) shared between
  the app and the extension. A valid **Apple Developer team** is needed so both
  the app and the extension get provisioning profiles for that App Group.
- On EAS, ensure only **one** extension target is configured during the
  credentials step (see the `expo-share-intent` FAQ).

The share **handling** code is platform-agnostic — `expo-share-intent` delivers
Android intents and iOS extension payloads through the same context — so no
runtime changes were needed to enable iOS beyond the `app.json` configuration.
