import 'package:flutter/material.dart';

import 'src/app.dart';
import 'src/config/app_config.dart';
import 'src/core/api_client.dart';
import 'src/core/api_service.dart';
import 'src/core/navigation_intent_service.dart';
import 'src/core/push_service.dart';
import 'src/core/session_store.dart';
import 'src/core/socket_service.dart';
import 'src/state/app_scope.dart';
import 'src/state/auth_store.dart';
import 'src/state/theme_store.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final sessionStore = SessionStore();
  final apiClient = ApiClient(
    defaultBaseUrl: AppConfig.apiBaseUrl,
    sessionStore: sessionStore,
  );
  final apiService = ApiService(apiClient);
  final navigationIntents = NavigationIntentService();
  final pushService = PushService(apiService, navigationIntents);
  final socketService = SocketService();
  final authStore = AuthStore(
    api: apiService,
    client: apiClient,
    pushService: pushService,
    socketService: socketService,
    sessionStore: sessionStore,
  );
  final themeStore = ThemeStore();

  await Future.wait([
    authStore.restore(),
    themeStore.restore(),
  ]);

  runApp(
    AppScope(
      auth: authStore,
      api: apiService,
      client: apiClient,
      socket: socketService,
      navigationIntents: navigationIntents,
      themes: themeStore,
      child: const AsystenceApp(),
    ),
  );
}
