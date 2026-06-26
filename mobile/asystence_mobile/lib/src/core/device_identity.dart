import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

/// Persistent per-install identifier for this device, distinct from the
/// signed-in user's id. The same account can be signed in on a phone, a
/// tablet, and the web app at once; the huddle lifecycle needs to tell those
/// apart so that starting a call on one device does not silently auto-join
/// and publish media on every other device the same user happens to be
/// signed into.
class DeviceIdentity {
  DeviceIdentity._();

  static const _prefsKey = 'asystence.huddleDeviceId.v1';
  static String? _cached;

  static Future<String> getOrCreate() async {
    if (_cached != null) return _cached!;
    final prefs = await SharedPreferences.getInstance();
    var id = prefs.getString(_prefsKey);
    if (id == null || id.isEmpty) {
      id = _generate();
      await prefs.setString(_prefsKey, id);
    }
    _cached = id;
    return id;
  }

  static String _generate() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    return 'android-${bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
  }
}
