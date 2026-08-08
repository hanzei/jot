# Deep linking into the mobile app

How an `https://<instance>/notes/<id>` link — the thing one person sends
another — ends up open in the Jot mobile app.

## Why this is not just Universal Links

The obvious answer is the platform mechanism: iOS Universal Links and Android
App Links let an `https` URL open an app directly. Neither is available to Jot,
and the reason is self-hosting.

**iOS** requires every domain the app claims to be listed in the
`com.apple.developer.associated-domains` entitlement, which is fixed at build
time. There is no runtime API to add one, and the only wildcard is
`*.example.com`, which still needs the parent domain baked in. One published
build cannot enumerate the domains its users happen to host Jot on
(`jot.example.com`, a Tailscale name, a homelab subdomain), so it cannot claim
them.

**Android** could match `scheme="https"` with `android:host="*"`, but a wildcard
host cannot be `autoVerify`'d. On Android 12+ an unverified web link goes
straight to the browser, and the app only gets it if the user turns on "Open
supported links" by hand. It would also make Jot a nominal handler for every
web link on the device.

Both would work for someone building the app with their own domain — see
[Building an app for one instance](#building-an-app-for-one-instance). What they
cannot do is work for a single build distributed to everyone.

So Jot forwards from the browser instead. The link always lands in the browser
first; the webapp is what hands it over.

## The URL shape

The app registers the `jot://` custom scheme (`mobile/app.json`), and the path
mirrors the web path with the instance carried as a query parameter:

```text
https://jot.example.com/notes/abc123
        ↓
jot://notes/abc123?server=https%3A%2F%2Fjot.example.com
```

The `server` parameter is what makes this work for a multi-server app. On
receiving a link the mobile app resolves it against the servers it knows
(`mobile/src/hooks/useDeepLinkRouting.ts`): it switches to the matching one,
offers to add it if it is unknown, and stashes the link to replay after login if
the session there is not valid.

`webapp/src/utils/deepLink.ts` owns the web→mobile mapping and is the single
place that knows which web paths have a mobile screen. Two callers use it to
offer the app manually: the banner in `NavigationHeader` and the deep-link
action in `NoteModal`.

## The arrival handoff

`webapp/src/components/MobileAppHandoff.tsx` is the automatic path. It runs once
per page load and only when all of the following hold:

- the device has a **coarse pointer** — the same signal `NoteModal` uses;
- the **entry URL** is a note URL (`/notes/:id`);
- the visitor has not dismissed the handoff on this device.

Two details are deliberate. It reads `window.location` rather than the router,
so the URL it judges is the one the visitor *arrived* on — the login bounce to
`/login?continue=…` does not erase it, and navigating to a note from inside the
running webapp never yanks the visitor out to the app. And it is scoped to notes
even though the app also has a `/settings` screen: a note URL is the one people
send each other, while settings is somewhere you navigate yourself.

### Learning whether the app is installed

Navigating to an unhandled custom scheme raises a browser error on iOS Safari,
so forwarding every visitor automatically would break the common case of someone
who does not have the app. Instead the handoff is learned:

| State | Behaviour |
|---|---|
| No prior success | Prompt: **Open in app** / **Continue in browser**. Nothing navigates on its own. |
| A prior handoff worked | Navigate to `jot://` immediately, behind an "Opening…" overlay. |

An attempt resolves on whichever comes first: the browser losing visibility —
which at that moment means another app took the URL, recorded as success — or a
1.5s timeout with the page still visible, which falls back to the prompt and
clears the flag, so an uninstalled app self-corrects.

The overlay is deliberately **not** a `@headlessui` `Dialog`, unlike every other
modal in the webapp. It can be on screen while the note modal opens underneath
it, and two Headless UI dialogs fight over the modal stack: the one opened last
marks the other inert regardless of z-index. It is a plain overlay above the
app's layers instead, and moves focus itself.

Storage keys, both in `localStorage` and owned by
`webapp/src/utils/mobileAppHandoff.ts`:

- `jot_mobile_app_installed` — a handoff from this browser reached the app.
- `jot_mobile_app_handoff_dismissed` — the visitor chose the browser, for good.

The dismissal is separate from `jot_mobile_app_banner_dismissed`: dismissing the
arrival handoff must not also remove the header banner, which is then the only
remaining way to reach the app by hand.

The dismissal is also **reversible**, via a settings row
(`webapp/src/components/MobileAppPreference.tsx`). "Continue in browser" is one
tap on a prompt nobody asked for, so leaving it as the only writer would make it
a one-way door out of the feature — and note that the dismissal is checked
before `jot_mobile_app_installed`, so someone who dismissed and later installed
the app would otherwise never get the handoff back. The row hides itself on a
fine pointer, and it is reachable precisely because the handoff is scoped to
note URLs: a handoff that also fired on `/settings` would be covering its own
escape hatch.

## Building an app for one instance

Someone building the app for their own instance *can* have true Universal Links,
since they know their domain at build time. It needs both halves:

1. Add the domain to `associatedDomains` (iOS) and an `autoVerify` intent filter
   (Android) in the Expo config.
2. Serve `/.well-known/apple-app-site-association` and
   `/.well-known/assetlinks.json` from the instance.

Jot's server does not serve those files today. Adding it would make this path
turnkey and is the natural next step if this comes up.

## Testing

- `webapp/src/components/__tests__/MobileAppHandoff.test.tsx` — the phase
  machine, with `window.location` stubbed since jsdom cannot navigate to a
  custom scheme.
- `webapp/e2e/tests/mobile-app-handoff.spec.ts` — runs in the `mobile-chrome`
  project only, since the handoff needs a coarse pointer. Chromium has no
  `jot://` handler, so every attempt there lands on the timeout branch — which
  is the branch everyone without the app sees, and the one worth guarding. It
  also carries the axe scan for this overlay, because `accessibility.spec.ts` is
  desktop-only and would never see it.
