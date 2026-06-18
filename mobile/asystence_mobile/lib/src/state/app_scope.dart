import 'package:flutter/widgets.dart';

import '../core/api_client.dart';
import '../core/api_service.dart';
import '../core/navigation_intent_service.dart';
import '../core/socket_service.dart';
import 'auth_store.dart';

class AppScope extends InheritedWidget {
  const AppScope({
    super.key,
    required this.auth,
    required this.api,
    required this.client,
    required this.socket,
    required this.navigationIntents,
    required super.child,
  });

  final AuthStore auth;
  final ApiService api;
  final ApiClient client;
  final SocketService socket;
  final NavigationIntentService navigationIntents;

  static AppScope of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'AppScope is missing from the widget tree');
    return scope!;
  }

  @override
  bool updateShouldNotify(AppScope oldWidget) {
    return auth != oldWidget.auth ||
        api != oldWidget.api ||
        client != oldWidget.client ||
        socket != oldWidget.socket ||
        navigationIntents != oldWidget.navigationIntents;
  }
}
