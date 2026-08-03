import 'package:flutter/foundation.dart' show kReleaseMode;
import 'package:flutter/material.dart';

class AppConfig {
  static const Color appBg = Color(0xff0a0a0b);
  static const Color surface = Color(0xff0a0a0b);
  static const Color surfaceSoft = Color(0xff0e0e10);
  static const Color surfaceStrong = Color(0xff18181c);
  static const Color border = Color(0xff242428);
  static const Color borderStrong = Color(0xff323238);
  static const Color text = Color(0xfffafafa);
  static const Color textMuted = Color(0xff8e8e96);
  static const Color textSoft = Color(0xff6f6f78);
  static const Color primary = Color(0xffffa500);
  static const Color primaryHover = Color(0xffffb733);
  static const Color primaryContrast = Color(0xff0a0a0b);

  static const appName = String.fromEnvironment(
    'APP_NAME',
    defaultValue: 'Asystence',
  );

  // Build-time overrides. Empty means "not supplied", which lets us fall back
  // per build mode below instead of baking one wrong value into every build.
  static const _apiBaseUrlOverride = String.fromEnvironment('API_BASE_URL');
  static const _webAppUrlOverride = String.fromEnvironment('WEB_APP_URL');

  static const _prodApiBaseUrl = 'https://api.asystence.com';
  static const _prodWebAppUrl = 'https://app.asystence.com';

  // 10.0.2.2 is the Android emulator's alias for the host machine's localhost.
  // It resolves to nothing on a real device.
  static const _devApiBaseUrl = 'http://10.0.2.2:5000';
  static const _devWebAppUrl = 'http://localhost:5173';

  /// Backend origin.
  ///
  /// A release build that forgot `--dart-define=API_BASE_URL=...` previously
  /// shipped pointing at the emulator loopback, so every request — including
  /// login — failed on a real phone with no indication why. Release builds now
  /// default to production and only debug builds fall back to the emulator
  /// address; an explicit --dart-define still overrides both.
  static String get apiBaseUrl => _apiBaseUrlOverride.isNotEmpty
      ? _apiBaseUrlOverride
      : (kReleaseMode ? _prodApiBaseUrl : _devApiBaseUrl);

  /// Web app origin, used for deep links out to pages the app doesn't cover.
  static String get webAppUrl => _webAppUrlOverride.isNotEmpty
      ? _webAppUrlOverride
      : (kReleaseMode ? _prodWebAppUrl : _devWebAppUrl);

  static const version = String.fromEnvironment(
    'APP_VERSION',
    defaultValue: '1.0.25',
  );

  static const versionCode = int.fromEnvironment(
    'APP_VERSION_CODE',
    defaultValue: 26,
  );

  static const allowApiOverride = bool.fromEnvironment(
    'ALLOW_API_OVERRIDE',
    defaultValue: false,
  );

  static const huddleLiveKitMobileCanaryEnabled = bool.fromEnvironment(
    'HUDDLE_LIVEKIT_MOBILE_CANARY_ENABLED',
    defaultValue: true,
  );

  static const huddleLiveKitMobileForceMesh = bool.fromEnvironment(
    'HUDDLE_LIVEKIT_MOBILE_FORCE_MESH',
    defaultValue: false,
  );

  static const huddleLiveKitMobileProviderVersion = String.fromEnvironment(
    'HUDDLE_LIVEKIT_MOBILE_PROVIDER_VERSION',
    defaultValue: 'mobile-livekit-canary-1',
  );
}
