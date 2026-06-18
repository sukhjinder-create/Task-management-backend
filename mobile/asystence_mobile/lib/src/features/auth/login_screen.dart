import 'package:flutter/material.dart';

import '../../config/app_config.dart';
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

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _mfaCode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = AppScope.of(context).auth;
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ListView(
            padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 28),
            shrinkWrap: true,
            children: [
              Center(
                child: Image.asset(
                  'assets/images/asystence-logo.png',
                  width: 72,
                  height: 72,
                  fit: BoxFit.contain,
                ),
              ),
              const SizedBox(height: 18),
              Text(
                AppConfig.appName,
                textAlign: TextAlign.center,
                style: theme.textTheme.headlineMedium?.copyWith(
                  color: AppConfig.text,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                _mfaToken == null
                    ? 'Sign in to your workspace.'
                    : 'Verify it is you.',
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: AppConfig.textMuted,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 28),
              SectionCard(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (_mfaToken == null) ...[
                      TextField(
                        controller: _email,
                        keyboardType: TextInputType.emailAddress,
                        autofillHints: const [AutofillHints.email],
                        decoration: const InputDecoration(
                          labelText: 'Email',
                          prefixIcon: Icon(Icons.mail_outline),
                        ),
                      ),
                      const SizedBox(height: 12),
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
