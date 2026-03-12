# Phase 1 — Project Setup & Authentication

## Goal

Bootstrap the Expo React Native project in `mobile/`, establish the navigation skeleton, and implement the complete authentication flow (login, register, logout). At the end of this phase a user can launch the app, register an account or log in, and land on an empty Notes tab.

---

## Prerequisites

- Node.js 20+
- Expo CLI (`npx expo`)
- A running Jot server (`task run-server`)

---

## What to Build

### 1. Expo Project Initialization

Create the `mobile/` directory with:

```
mobile/
├── app.json
├── App.tsx
├── babel.config.js
├── tsconfig.json
├── package.json
├── src/
│   ├── navigation/
│   │   ├── AuthStack.tsx
│   │   ├── MainTabs.tsx
│   │   └── RootNavigator.tsx
│   ├── screens/
│   │   ├── LoginScreen.tsx
│   │   ├── RegisterScreen.tsx
│   │   └── NotesListScreen.tsx      # placeholder
│   ├── api/
│   │   └── client.ts
│   ├── store/
│   │   └── AuthContext.tsx
│   └── types/
│       └── index.ts
└── __tests__/
```

**Key dependencies:**

| Package | Purpose |
|---------|---------|
| `expo` | Managed workflow framework |
| `react-native` | Core UI framework |
| `@react-navigation/native` | Navigation container |
| `@react-navigation/native-stack` | Stack navigator (auth flow) |
| `@react-navigation/bottom-tabs` | Bottom tab bar |
| `react-native-screens` | Native screen containers |
| `react-native-safe-area-context` | Safe area handling |
| `axios` | HTTP client |
| `expo-secure-store` | Persist session token securely |

Also set up:
- TypeScript with strict mode
- ESLint + `@typescript-eslint` (add `lint` and `typecheck` scripts to `package.json`)
- Prettier (match webapp config if one exists)

### 2. TypeScript Types

Copy or re-export the shared types from the webapp. At minimum:

```typescript
// User, Note, NoteItem, NoteShare, Label, UserSettings
// Plus auth-specific types:
interface LoginRequest { username: string; password: string }
interface RegisterRequest { username: string; password: string; first_name: string; last_name: string }
interface AuthResponse { user: User; settings: UserSettings }
```

### 3. API Client (`src/api/client.ts`)

- Create an axios instance with `baseURL` pointing to the Jot server
- On login, extract the `jot_session` value from the `Set-Cookie` response header
- Store the session token in `expo-secure-store`
- Attach the token as a `Cookie: jot_session=<token>` header on every subsequent request via an axios request interceptor
- On 401 response, clear the stored session and redirect to login
- API functions for this phase:
  - `login(username, password)` → `POST /api/v1/login`
  - `register(username, password, firstName, lastName)` → `POST /api/v1/register`
  - `logout()` → `POST /api/v1/logout`
  - `getMe()` → `GET /api/v1/me`

### 4. Auth State (`src/store/AuthContext.tsx`)

A React context providing:
- `user: User | null`
- `settings: UserSettings | null`
- `isAuthenticated: boolean`
- `isLoading: boolean` (true while checking stored session on app launch)
- `login(username, password)` — calls API, stores session, sets user
- `register(...)` — calls API, stores session, sets user
- `logout()` — calls API, clears session, clears user

On app launch, check `expo-secure-store` for an existing token. If found, call `GET /api/v1/me` to validate the session. If valid, set user and skip login. If invalid (401), clear the token and show login.

### 5. Navigation (`src/navigation/`)

**RootNavigator** — conditionally renders:
- `AuthStack` when not authenticated (Login → Register)
- `MainTabs` when authenticated

**AuthStack** — native stack:
- `Login` screen (initial)
- `Register` screen

**MainTabs** — bottom tab bar with three tabs (screens are placeholders for now):
- Notes (icon: document-text)
- Archived (icon: archive-box)
- Trash (icon: trash)

### 6. Login Screen

- Username and password text inputs
- "Sign in" button (disabled while loading)
- "Create account" link → navigates to Register
- Error message display for invalid credentials
- Keyboard-avoiding view

### 7. Register Screen

- Username, first name, last name, password text inputs
- "Create account" button
- "Already have an account?" link → navigates back to Login
- Validation: all fields required, username 2–30 chars
- On success, auto-login and navigate to Notes

---

## Server Endpoints Consumed

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/login` | Authenticate, receive session cookie |
| POST | `/api/v1/register` | Create account |
| POST | `/api/v1/logout` | End session |
| GET | `/api/v1/me` | Validate existing session on app launch |

---

## Acceptance Criteria

- [ ] `mobile/` directory exists with a working Expo project
- [ ] App launches in an Android emulator or device
- [ ] User can register a new account with username, first/last name, and password
- [ ] User can log in with valid credentials
- [ ] Invalid credentials show an error message
- [ ] Session persists across app restarts (re-opening the app skips login)
- [ ] Logout clears the session and returns to login screen
- [ ] Bottom tab bar shows Notes, Archived, Trash tabs (placeholder content)
- [ ] `npm run lint` and `npm run typecheck` pass with no errors
- [ ] Unit tests exist for AuthContext and API client
