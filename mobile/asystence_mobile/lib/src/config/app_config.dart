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

  static const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://asystence-api-616077735050.asia-south1.run.app',
  );

  static const version = String.fromEnvironment(
    'APP_VERSION',
    defaultValue: '1.0.12',
  );

  static const versionCode = int.fromEnvironment(
    'APP_VERSION_CODE',
    defaultValue: 13,
  );

  static const allowApiOverride = bool.fromEnvironment(
    'ALLOW_API_OVERRIDE',
    defaultValue: false,
  );

  static const huddleLiveKitMobileCanaryEnabled = bool.fromEnvironment(
    'HUDDLE_LIVEKIT_MOBILE_CANARY_ENABLED',
    defaultValue: false,
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
