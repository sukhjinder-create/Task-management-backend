import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/api_client.dart';
import '../core/api_service.dart';
import '../core/models.dart';
import '../core/push_service.dart';
import '../core/session_store.dart';
import '../core/socket_service.dart';
import '../config/app_config.dart';

class AuthStore extends ChangeNotifier {
  AuthStore({
    required this.api,
    required this.client,
    required this.pushService,
    required this.socketService,
    required this.sessionStore,
  }) {
    client.sessionProvider = () => _session;
    client.onSessionChanged = _replaceSession;
  }

  final ApiService api;
  final ApiClient client;
  final PushService pushService;
  final SocketService socketService;
  final SessionStore sessionStore;

  bool _initialized = false;
  bool _busy = false;
  AuthSession? _session;
  String? _error;

  bool get initialized => _initialized;
  bool get busy => _busy;
  AuthSession? get session => _session;
  User? get user => _session?.user;
  String? get error => _error;
  bool get isLoggedIn => _session != null;

  Future<void> restore() async {
    _busy = true;
    try {
      _session = await sessionStore.loadSession();
      final storedBaseUrl = await sessionStore.loadApiBaseUrl();
      if (AppConfig.allowApiOverride && storedBaseUrl != null) {
        await client.setBaseUrl(storedBaseUrl);
      }
      if (_session != null) {
        _connectSocket();
        await pushService.registerCurrentDevice();
      }
    } finally {
      _initialized = true;
      _busy = false;
      notifyListeners();
    }
  }

  Future<LoginResult> login(String email, String password) async {
    return _guard(() async {
      final result = await api.login(email, password);
      if (result.session != null) {
        await _replaceSession(result.session);
      }
      return result;
    });
  }

  Future<void> verifyMfa(String mfaSessionToken, String code) async {
    await _guard(() async {
      final session = await api.verifyMfa(mfaSessionToken, code);
      await _replaceSession(session);
    });
  }

  Future<void> completeExternalLogin({
    required String token,
    required String refreshToken,
  }) async {
    await _guard(() async {
      final payload = _decodeJwtPayload(token);
      final provisionalUser = User.fromJson(payload);
      var session = AuthSession(
        token: token,
        refreshToken: refreshToken,
        user: provisionalUser,
      );
      await _replaceSession(session);
      try {
        final user = await api.me();
        session = session.copyWith(user: user);
        await _replaceSession(session);
      } catch (_) {
        // The signed JWT already contains the identity and workspace needed
        // to enter the app. A later profile refresh can fill optional fields.
      }
    });
  }

  Future<void> refreshMe() async {
    final current = _session;
    if (current == null) return;
    await _guard(() async {
      final user = await api.me();
      await _replaceSession(current.copyWith(user: user));
    });
  }

  Future<void> logout() async {
    final refreshToken = _session?.refreshToken;
    await pushService.unregisterCurrentDevice();
    if (refreshToken != null && refreshToken.isNotEmpty) {
      api.logout(refreshToken).catchError((_) {});
    }
    await _replaceSession(null);
  }

  Future<void> updateApiBaseUrl(String value) async {
    await client.setBaseUrl(value);
    notifyListeners();
  }

  Future<T> _guard<T>(Future<T> Function() action) async {
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      return await action();
    } on ApiException catch (err) {
      _error = err.message;
      rethrow;
    } catch (err) {
      _error = '$err';
      rethrow;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  Future<void> _replaceSession(AuthSession? session) async {
    _session = session;
    if (session == null) {
      await sessionStore.clearSession();
      socketService.disconnect();
    } else {
      await sessionStore.saveSession(session);
      _connectSocket();
      await pushService.registerCurrentDevice();
    }
    notifyListeners();
  }

  void _connectSocket() {
    final session = _session;
    if (session == null || session.token.isEmpty) return;
    socketService.connect(
      baseUrl: client.currentBaseUrl,
      token: session.token,
    );
  }

  JsonMap _decodeJwtPayload(String token) {
    final parts = token.split('.');
    if (parts.length != 3) {
      throw ApiException('Invalid Google sign-in response');
    }
    try {
      final normalized = base64Url.normalize(parts[1]);
      final decoded = jsonDecode(utf8.decode(base64Url.decode(normalized)));
      if (decoded is Map) return JsonMap.from(decoded);
    } catch (_) {}
    throw ApiException('Invalid Google sign-in response');
  }
}
