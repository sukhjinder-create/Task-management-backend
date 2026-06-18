import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'config/app_config.dart';
import 'core/app_update_service.dart';
import 'core/models.dart';
import 'features/auth/login_screen.dart';
import 'features/shell/home_shell.dart';
import 'state/app_scope.dart';
import 'state/theme_store.dart';

class AsystenceApp extends StatefulWidget {
  const AsystenceApp({super.key});

  @override
  State<AsystenceApp> createState() => _AsystenceAppState();
}

class _AsystenceAppState extends State<AsystenceApp>
    with WidgetsBindingObserver {
  final _navigatorKey = GlobalKey<NavigatorState>();
  bool _checkingForUpdate = false;
  bool _authReadyCheckScheduled = false;
  DateTime? _lastUpdateCheckAt;
  int? _lastPromptedVersionCode;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _scheduleUpdateCheck(force: true);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _scheduleUpdateCheck();
    }
  }

  void _scheduleUpdateCheck({bool force = false}) {
    WidgetsBinding.instance
        .addPostFrameCallback((_) => _checkForUpdate(force: force));
  }

  Future<void> _checkForUpdate({bool force = false}) async {
    if (_checkingForUpdate) return;
    final now = DateTime.now();
    final last = _lastUpdateCheckAt;
    if (!force &&
        last != null &&
        now.difference(last) < const Duration(minutes: 20)) {
      return;
    }

    _checkingForUpdate = true;
    _lastUpdateCheckAt = now;
    try {
      final api = AppScope.of(context).api;
      final update = await AppUpdateService(api).findUpdate();
      if (!mounted || update == null) return;
      if (_lastPromptedVersionCode == update.versionCode && !update.mandatory) {
        return;
      }
      _lastPromptedVersionCode = update.versionCode;

      final dialogContext = _navigatorKey.currentContext;
      if (dialogContext == null || !dialogContext.mounted) return;
      await showDialog<void>(
        context: dialogContext,
        barrierDismissible: !update.mandatory,
        builder: (_) => _UpdateDialog(update: update),
      );
    } catch (_) {
      // Update checks must never block sign-in or app startup.
    } finally {
      _checkingForUpdate = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final scope = AppScope.of(context);
    final auth = scope.auth;
    final themes = scope.themes;
    return AnimatedBuilder(
      animation: Listenable.merge([auth, themes]),
      builder: (context, _) {
        if (auth.initialized && !_authReadyCheckScheduled) {
          _authReadyCheckScheduled = true;
          _scheduleUpdateCheck(force: true);
        }
        return MaterialApp(
          title: AppConfig.appName,
          navigatorKey: _navigatorKey,
          debugShowCheckedModeBanner: false,
          theme: _theme(Brightness.light, themes.selection),
          darkTheme: _theme(Brightness.dark, themes.selection),
          themeMode: themes.selection.themeMode,
          home: !auth.initialized
              ? const _BootScreen()
              : auth.isLoggedIn
                  ? const HomeShell()
                  : const LoginScreen(),
        );
      },
    );
  }

  ThemeData _theme(Brightness brightness, AppThemeOption option) {
    final palette = _ThemePalette.forOption(option, brightness);
    final colorScheme = ColorScheme.fromSeed(
      seedColor: palette.primary,
      brightness: palette.brightness,
    ).copyWith(
      primary: palette.primary,
      onPrimary: palette.primaryContrast,
      secondary: palette.primaryHover,
      surface: palette.surface,
      onSurface: palette.text,
      surfaceContainerHighest: palette.surfaceStrong,
      onSurfaceVariant: palette.textMuted,
      outline: palette.border,
      outlineVariant: palette.borderStrong,
      error: const Color(0xffef4444),
    );

    return ThemeData(
      useMaterial3: true,
      brightness: palette.brightness,
      colorScheme: colorScheme,
      fontFamily: 'Inter',
      scaffoldBackgroundColor: palette.appBg,
      appBarTheme: AppBarTheme(
        backgroundColor: palette.appBg,
        foregroundColor: palette.text,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          color: palette.text,
          fontSize: 17,
          fontWeight: FontWeight.w700,
          letterSpacing: 0,
        ),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8),
          side: BorderSide(color: palette.border),
        ),
        color: palette.surface,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: palette.surfaceSoft,
        labelStyle: TextStyle(color: palette.textMuted),
        hintStyle: TextStyle(color: palette.textSoft),
        prefixIconColor: palette.textSoft,
        suffixIconColor: palette.textSoft,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: BorderSide(color: palette.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: BorderSide(color: palette.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: BorderSide(color: palette.primary),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: palette.primary,
          foregroundColor: palette.primaryContrast,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          textStyle: const TextStyle(fontWeight: FontWeight.w700),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: palette.primary,
          side: BorderSide(color: palette.borderStrong),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: palette.appBg,
        indicatorColor: palette.surfaceStrong,
        iconTheme: WidgetStateProperty.resolveWith(
          (states) => IconThemeData(
            color: states.contains(WidgetState.selected)
                ? palette.primary
                : palette.textMuted,
          ),
        ),
        labelTextStyle: WidgetStateProperty.resolveWith(
          (states) => TextStyle(
            fontSize: 11,
            fontWeight: states.contains(WidgetState.selected)
                ? FontWeight.w700
                : FontWeight.w500,
          ),
        ),
      ),
      drawerTheme: DrawerThemeData(backgroundColor: palette.appBg),
    );
  }
}

class _ThemePalette {
  const _ThemePalette({
    required this.brightness,
    required this.appBg,
    required this.surface,
    required this.surfaceSoft,
    required this.surfaceStrong,
    required this.border,
    required this.borderStrong,
    required this.text,
    required this.textMuted,
    required this.textSoft,
    required this.primary,
    required this.primaryHover,
    required this.primaryContrast,
  });

  final Brightness brightness;
  final Color appBg;
  final Color surface;
  final Color surfaceSoft;
  final Color surfaceStrong;
  final Color border;
  final Color borderStrong;
  final Color text;
  final Color textMuted;
  final Color textSoft;
  final Color primary;
  final Color primaryHover;
  final Color primaryContrast;

  factory _ThemePalette.forOption(
    AppThemeOption option,
    Brightness systemBrightness,
  ) {
    if (option == AppThemeOption.light ||
        (option == AppThemeOption.system &&
            systemBrightness == Brightness.light)) {
      return const _ThemePalette(
        brightness: Brightness.light,
        appBg: Color(0xfff7f7f8),
        surface: Color(0xffffffff),
        surfaceSoft: Color(0xfff1f1f3),
        surfaceStrong: Color(0xffe7e7eb),
        border: Color(0xffdedee3),
        borderStrong: Color(0xffc9c9d0),
        text: Color(0xff17171a),
        textMuted: Color(0xff62626b),
        textSoft: Color(0xff858590),
        primary: AppConfig.primary,
        primaryHover: Color(0xffe99100),
        primaryContrast: Color(0xff17171a),
      );
    }

    switch (option) {
      case AppThemeOption.ocean:
        return _darkAccent(
          primary: const Color(0xff38bdf8),
          hover: const Color(0xff7dd3fc),
          bg: const Color(0xff06131d),
          surface: const Color(0xff0a1b28),
        );
      case AppThemeOption.forest:
        return _darkAccent(
          primary: const Color(0xff4ade80),
          hover: const Color(0xff86efac),
          bg: const Color(0xff07150d),
          surface: const Color(0xff0c2014),
        );
      case AppThemeOption.sunset:
        return _darkAccent(
          primary: const Color(0xffff7043),
          hover: const Color(0xffff9a76),
          bg: const Color(0xff1a0b08),
          surface: const Color(0xff26100c),
        );
      case AppThemeOption.yellow:
        return _darkAccent(
          primary: const Color(0xfffacc15),
          hover: const Color(0xfffde047),
          bg: const Color(0xff171407),
          surface: const Color(0xff211d09),
        );
      default:
        return _darkAccent(
          primary: AppConfig.primary,
          hover: AppConfig.primaryHover,
          bg: AppConfig.appBg,
          surface: AppConfig.surface,
        );
    }
  }

  static _ThemePalette _darkAccent({
    required Color primary,
    required Color hover,
    required Color bg,
    required Color surface,
  }) {
    return _ThemePalette(
      brightness: Brightness.dark,
      appBg: bg,
      surface: surface,
      surfaceSoft: Color.alphaBlend(
        Colors.white.withValues(alpha: 0.035),
        surface,
      ),
      surfaceStrong: Color.alphaBlend(
        Colors.white.withValues(alpha: 0.08),
        surface,
      ),
      border: Color.alphaBlend(
        Colors.white.withValues(alpha: 0.11),
        surface,
      ),
      borderStrong: Color.alphaBlend(
        Colors.white.withValues(alpha: 0.18),
        surface,
      ),
      text: const Color(0xfffafafa),
      textMuted: const Color(0xffa0a0aa),
      textSoft: const Color(0xff74747e),
      primary: primary,
      primaryHover: hover,
      primaryContrast: const Color(0xff0a0a0b),
    );
  }
}

class _UpdateDialog extends StatelessWidget {
  const _UpdateDialog({required this.update});

  final AppVersionInfo update;

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Update to ${update.version}'),
      content: Text(
        update.notes?.trim().isNotEmpty == true
            ? update.notes!
            : 'A newer Android app release is available.',
      ),
      actions: [
        if (!update.mandatory)
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Later'),
          ),
        FilledButton(
          onPressed: () async {
            final uri = Uri.parse(update.apkUrl);
            await launchUrl(uri, mode: LaunchMode.externalApplication);
          },
          child: const Text('Download'),
        ),
      ],
    );
  }
}

class _BootScreen extends StatelessWidget {
  const _BootScreen();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: SizedBox(
          width: 28,
          height: 28,
          child: CircularProgressIndicator(strokeWidth: 2.4),
        ),
      ),
    );
  }
}
