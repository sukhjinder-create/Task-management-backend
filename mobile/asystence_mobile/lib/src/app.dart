import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'config/app_config.dart';
import 'config/app_theme.dart';
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
          theme: AppTheme.build(
            AppTheme.paletteFor(themes.selection, Brightness.light),
          ),
          darkTheme: AppTheme.build(
            AppTheme.paletteFor(themes.selection, Brightness.dark),
          ),
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
