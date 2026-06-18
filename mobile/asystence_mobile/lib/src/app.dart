import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'config/app_config.dart';
import 'core/app_update_service.dart';
import 'core/models.dart';
import 'features/auth/login_screen.dart';
import 'features/shell/home_shell.dart';
import 'state/app_scope.dart';

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
    final auth = AppScope.of(context).auth;
    return AnimatedBuilder(
      animation: auth,
      builder: (context, _) {
        if (auth.initialized && !_authReadyCheckScheduled) {
          _authReadyCheckScheduled = true;
          _scheduleUpdateCheck(force: true);
        }
        return MaterialApp(
          title: AppConfig.appName,
          navigatorKey: _navigatorKey,
          debugShowCheckedModeBanner: false,
          theme: _theme(Brightness.light),
          darkTheme: _theme(Brightness.dark),
          themeMode: ThemeMode.system,
          home: !auth.initialized
              ? const _BootScreen()
              : auth.isLoggedIn
                  ? const HomeShell()
                  : const LoginScreen(),
        );
      },
    );
  }

  ThemeData _theme(Brightness brightness) {
    final colorScheme = ColorScheme.fromSeed(
      seedColor: AppConfig.primary,
      brightness: Brightness.dark,
    ).copyWith(
      primary: AppConfig.primary,
      onPrimary: AppConfig.primaryContrast,
      secondary: AppConfig.primaryHover,
      surface: AppConfig.surface,
      onSurface: AppConfig.text,
      surfaceContainerHighest: AppConfig.surfaceStrong,
      onSurfaceVariant: AppConfig.textMuted,
      outline: AppConfig.border,
      outlineVariant: AppConfig.borderStrong,
      error: const Color(0xffef4444),
    );

    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: colorScheme,
      fontFamily: 'Inter',
      scaffoldBackgroundColor: AppConfig.appBg,
      appBarTheme: const AppBarTheme(
        backgroundColor: AppConfig.appBg,
        foregroundColor: AppConfig.text,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          color: AppConfig.text,
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
          side: const BorderSide(color: AppConfig.border),
        ),
        color: AppConfig.surface,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppConfig.surfaceSoft,
        labelStyle: const TextStyle(color: AppConfig.textMuted),
        hintStyle: const TextStyle(color: AppConfig.textSoft),
        prefixIconColor: AppConfig.textSoft,
        suffixIconColor: AppConfig.textSoft,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: AppConfig.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: AppConfig.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide: const BorderSide(color: AppConfig.primary),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AppConfig.primary,
          foregroundColor: AppConfig.primaryContrast,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          textStyle: const TextStyle(fontWeight: FontWeight.w700),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppConfig.primary,
          side: const BorderSide(color: AppConfig.borderStrong),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: AppConfig.appBg,
        indicatorColor: AppConfig.surfaceStrong,
        iconTheme: WidgetStateProperty.resolveWith(
          (states) => IconThemeData(
            color: states.contains(WidgetState.selected)
                ? AppConfig.primary
                : AppConfig.textMuted,
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
      drawerTheme: const DrawerThemeData(backgroundColor: AppConfig.appBg),
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
