import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import 'api_service.dart';
import 'navigation_intent_service.dart';

class PushService {
  PushService(this.api, this.navigationIntents);

  final ApiService api;
  final NavigationIntentService navigationIntents;

  FirebaseMessaging? _messaging;
  String? _registeredToken;
  bool _configured = false;
  bool _supported = true;

  Future<void> configure() async {
    if (_configured || !_supported) return;
    if (kIsWeb || (!Platform.isAndroid && !Platform.isIOS)) {
      _supported = false;
      return;
    }

    try {
      await Firebase.initializeApp();
      _messaging = FirebaseMessaging.instance;
      await _messaging!
          .requestPermission(alert: true, badge: true, sound: true);
      await _messaging!.setForegroundNotificationPresentationOptions(
        alert: true,
        badge: true,
        sound: true,
      );
      FirebaseMessaging.onMessageOpenedApp.listen((message) {
        navigationIntents.fromPushData(message.data);
      });
      final initialMessage = await _messaging!.getInitialMessage();
      if (initialMessage != null) {
        Future.microtask(
          () => navigationIntents.fromPushData(initialMessage.data),
        );
      }
      _messaging!.onTokenRefresh.listen((token) {
        _registeredToken = token;
        _registerToken(token);
      });
      _configured = true;
    } catch (_) {
      _supported = false;
    }
  }

  Future<void> registerCurrentDevice() async {
    await configure();
    final messaging = _messaging;
    if (!_supported || messaging == null) return;

    try {
      final token = await messaging.getToken();
      if (token == null || token.isEmpty) return;
      _registeredToken = token;
      await _registerToken(token);
    } catch (_) {}
  }

  Future<void> unregisterCurrentDevice() async {
    final token = _registeredToken;
    if (token == null || token.isEmpty) return;
    try {
      await api.unsubscribePushToken(token);
      _registeredToken = null;
    } catch (_) {}
  }

  Future<void> _registerToken(String token) {
    return api.subscribePushToken(
      platform: Platform.isIOS ? 'ios' : 'android',
      fcmToken: token,
    );
  }
}
