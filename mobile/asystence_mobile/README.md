# Asystence Mobile

Native Flutter mobile app for the existing Asystence Node/Express backend.

This is intentionally **not** a Capacitor/WebView build. It is Flutter source that talks to the existing API, keeps tokens in secure storage, sends the same `Authorization` and `x-workspace-id` headers as the web app, connects to the existing Socket.IO realtime server for chat/presence updates, and registers FCM tokens with the backend push API.

Production Android package: `com.proxima.app`

Production API is supplied at build time with `--dart-define=API_BASE_URL=...`.

## Local Setup

This app has generated Android and iOS platform projects in `android/` and `ios/`.
The local Flutter SDK used during validation is `C:\tmp\flutter`.
Android SDK tooling is available through a no-space junction at `C:\Android\sdk`; this avoids NDK/App Bundle issues caused by the user-profile path containing spaces.

```powershell
cd mobile/asystence_mobile
C:\tmp\flutter\bin\flutter.bat pub get
C:\tmp\flutter\bin\flutter.bat analyze
C:\tmp\flutter\bin\flutter.bat test
C:\tmp\flutter\bin\flutter.bat run
```

The app defaults to the Android emulator local backend. Override it for a real device,
staging, or production:

```powershell
C:\tmp\flutter\bin\flutter.bat run --dart-define=API_BASE_URL=http://192.168.x.x:5000 --dart-define=WEB_APP_URL=http://192.168.x.x:5173
```

Validated Android artifacts:

```text
build/app/outputs/flutter-apk/app-debug.apk
build/app/outputs/flutter-apk/app-release.apk
build/app/outputs/bundle/release/app-release.aab
```

## Product Coverage

The mobile app deliberately focuses on workflows that work well on a phone:

- Auth, MFA, token refresh, logout, forgot password
- Dashboard and role-scoped work summary
- Projects and project administration for authorized roles
- Task creation/editing, assignment, status, comments, subtasks, activity, and durable attachments
- My tasks
- Chat channels, direct messages, attachments, unread state, Socket.IO live updates, and huddles
- Notifications and read state
- Leave requests, balances, cancellation, and admin approval/rejection
- Profile photo, attendance actions, notification preferences, and password change

Desktop-heavy administration is intentionally not exposed in the native app:
testing agent, migrations/integrations, billing checkout, enterprise configuration,
workspace intelligence consoles, raw reports, superadmin, and other table-heavy
settings remain available on the web application.

## Backend Contract

API base is build-time configuration:

```text
--dart-define=API_BASE_URL=<backend origin>
--dart-define=WEB_APP_URL=<web app origin>
```

The app expects the existing backend routes mounted in `index.js`, especially:

- `/auth/login`, `/auth/mfa/verify`, `/auth/refresh`, `/auth/logout`, `/users/me`
- `/dashboard/overview`
- `/projects`, `/tasks`, `/comments`, `/subtasks`
- `/chat`, `/chat/messages`
- `/notifications`, `/attendance`, `/push`
- `/leave`

## Notes

- Android push notification registration is wired through Firebase Messaging and `/push/subscribe`.
- Android Firebase config is copied from the Capacitor app into `android/app/google-services.json`.
- Android release signing is configured through ignored local files: `android/key.properties` and `android/keystore/upload-keystore.jks`.
- Google/SSO/payment checkout flows open external browser URLs via `url_launcher`.
- File attachments use `file_picker` and multipart upload against `/tasks/:taskId/attachments`.
- `file_picker` is vendored in `vendor/file_picker` with Android `compileSdk 36` so attachment picking builds cleanly with the current Flutter/Android toolchain.
- iOS source is generated and ready, but iOS archive/signing must be done on macOS with Xcode and Apple signing credentials.
