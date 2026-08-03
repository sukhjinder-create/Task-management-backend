import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../config/app_config.dart';
import '../../config/design_tokens.dart';
import '../../core/models.dart';
import '../../core/ui.dart';
import '../../state/app_scope.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _mfaCode = TextEditingController();
  bool _showPassword = false;
  String? _mfaToken;
  bool _googleBusy = false;
  late final AppLinks _appLinks;
  StreamSubscription<Uri>? _linkSubscription;

  @override
  void initState() {
    super.initState();
    _appLinks = AppLinks();
    _linkSubscription = _appLinks.uriLinkStream.listen(_handleAuthLink);
    unawaited(_readInitialLink());
  }

  @override
  void dispose() {
    _linkSubscription?.cancel();
    _email.dispose();
    _password.dispose();
    _mfaCode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = AppScope.of(context).auth;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ListView(
            padding: const EdgeInsets.symmetric(
              horizontal: Insets.lg,
              vertical: Insets.xxl,
            ),
            shrinkWrap: true,
            children: [
              Center(
                child: Container(
                  width: 76,
                  height: 76,
                  padding: const EdgeInsets.all(Insets.md),
                  decoration: BoxDecoration(
                    color: context.palette.primarySoft,
                    borderRadius: BorderRadius.circular(Radii.xl),
                    border: Border.all(color: scheme.outline),
                  ),
                  child: Image.asset(
                    'assets/images/asystence-logo.png',
                    fit: BoxFit.contain,
                  ),
                ),
              ),
              const SizedBox(height: Insets.lg),
              Text(
                AppConfig.appName,
                textAlign: TextAlign.center,
                style: theme.textTheme.displaySmall,
              ),
              const SizedBox(height: Insets.xs),
              Text(
                _mfaToken == null
                    ? 'Sign in to your workspace.'
                    : 'Verify it is you.',
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium,
              ),
              const SizedBox(height: Insets.xl + Insets.xxs),
              SectionCard(
                padding: const EdgeInsets.all(Insets.lg),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (_mfaToken == null) ...[
                      OutlinedButton.icon(
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size.fromHeight(48),
                          foregroundColor: scheme.onSurface,
                        ),
                        onPressed:
                            auth.busy || _googleBusy ? null : _signInWithGoogle,
                        icon: _googleBusy
                            ? const SizedBox(
                                width: 17,
                                height: 17,
                                child:
                                    CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const _GoogleMark(),
                        label: const Text('Sign in with Google'),
                      ),
                      const SizedBox(height: Insets.md),
                      Row(
                        children: [
                          const Expanded(child: Divider()),
                          Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 12),
                            child: Text(
                              'or use email',
                              style: theme.textTheme.labelSmall,
                            ),
                          ),
                          const Expanded(child: Divider()),
                        ],
                      ),
                      const SizedBox(height: Insets.md),
                      TextField(
                        controller: _email,
                        keyboardType: TextInputType.emailAddress,
                        autofillHints: const [AutofillHints.email],
                        decoration: const InputDecoration(
                          labelText: 'Email',
                          prefixIcon: Icon(Icons.mail_outline),
                        ),
                      ),
                      const SizedBox(height: Insets.sm),
                      TextField(
                        controller: _password,
                        obscureText: !_showPassword,
                        autofillHints: const [AutofillHints.password],
                        decoration: InputDecoration(
                          labelText: 'Password',
                          prefixIcon: const Icon(Icons.lock_outline),
                          suffixIcon: IconButton(
                            onPressed: () =>
                                setState(() => _showPassword = !_showPassword),
                            icon: Icon(
                              _showPassword
                                  ? Icons.visibility_off
                                  : Icons.visibility,
                            ),
                          ),
                        ),
                      ),
                    ] else ...[
                      Text(
                        'Multi-factor verification',
                        style: theme.textTheme.titleMedium
                            ?.copyWith(fontWeight: FontWeight.w800),
                      ),
                      const SizedBox(height: 8),
                      TextField(
                        controller: _mfaCode,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                          labelText: 'Authenticator code',
                          prefixIcon: Icon(Icons.password),
                        ),
                      ),
                    ],
                    const SizedBox(height: 16),
                    FilledButton.icon(
                      style: FilledButton.styleFrom(
                        minimumSize: const Size.fromHeight(54),
                      ),
                      onPressed: auth.busy ? null : _submit,
                      icon: auth.busy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.login),
                      label: Text(_mfaToken == null ? 'Sign in' : 'Verify'),
                    ),
                    if (_mfaToken != null)
                      TextButton(
                        onPressed: auth.busy
                            ? null
                            : () => setState(() => _mfaToken = null),
                        child: const Text('Use another account'),
                      ),
                    if (_mfaToken == null)
                      TextButton(
                        onPressed: auth.busy ? null : _forgotPassword,
                        child: const Text('Forgot password'),
                      ),
                    if (auth.error != null) ...[
                      const SizedBox(height: 10),
                      Text(
                        auth.error!,
                        style: TextStyle(color: theme.colorScheme.error),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _readInitialLink() async {
    try {
      final uri = await _appLinks.getInitialLink();
      if (uri != null) await _handleAuthLink(uri);
    } catch (_) {}
  }

  Future<void> _signInWithGoogle() async {
    setState(() => _googleBusy = true);
    try {
      final baseUrl = await AppScope.of(context).client.baseUrl;
      final uri = Uri.parse('$baseUrl/auth/google').replace(
        queryParameters: const {'client': 'mobile'},
      );
      final opened = await launchUrl(
        uri,
        mode: LaunchMode.externalApplication,
      );
      if (!opened && mounted) {
        showSnack(context, 'Could not open Google sign-in');
      }
    } catch (error) {
      if (mounted) showSnack(context, 'Could not start Google sign-in: $error');
    } finally {
      if (mounted) setState(() => _googleBusy = false);
    }
  }

  Future<void> _handleAuthLink(Uri uri) async {
    if (uri.scheme != 'asystence' ||
        uri.host != 'auth' ||
        uri.path != '/callback') {
      return;
    }

    final error = uri.queryParameters['error'];
    if (error != null && error.trim().isNotEmpty) {
      if (mounted) showSnack(context, Uri.decodeComponent(error));
      return;
    }

    final token = uri.queryParameters['token'];
    final refreshToken = uri.queryParameters['refreshToken'];
    if (token == null ||
        token.trim().isEmpty ||
        refreshToken == null ||
        refreshToken.trim().isEmpty) {
      if (mounted) {
        showSnack(context, 'Google sign-in did not return a session');
      }
      return;
    }

    try {
      await AppScope.of(context).auth.completeExternalLogin(
            token: token,
            refreshToken: refreshToken,
          );
    } catch (error) {
      if (mounted) showSnack(context, '$error');
    }
  }

  Future<void> _submit() async {
    final auth = AppScope.of(context).auth;
    try {
      if (_mfaToken != null) {
        await auth.verifyMfa(_mfaToken!, _mfaCode.text.trim());
        return;
      }

      final result = await auth.login(_email.text.trim(), _password.text);
      if (result.mfaRequired) {
        setState(() => _mfaToken = result.mfaSessionToken);
      }
    } on ApiException catch (err) {
      if (mounted) showSnack(context, err.message);
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    }
  }

  Future<void> _forgotPassword() async {
    final email = _email.text.trim();
    if (email.isEmpty) {
      showSnack(context, 'Enter your email first');
      return;
    }
    try {
      await AppScope.of(context).api.forgotPassword(email);
      if (mounted) {
        showSnack(
          context,
          'If the account exists, reset instructions were sent.',
        );
      }
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    }
  }
}

class _GoogleMark extends StatelessWidget {
  const _GoogleMark();

  @override
  Widget build(BuildContext context) {
    return const SizedBox(
      width: 18,
      height: 18,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Text(
            'G',
            style: TextStyle(
              color: Color(0xff4285f4),
              fontSize: 17,
              fontWeight: FontWeight.w900,
            ),
          ),
        ],
      ),
    );
  }
}
