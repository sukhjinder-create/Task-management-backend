import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../config/app_config.dart';
import 'api_service.dart';
import 'models.dart';

class AppUpdateService {
  AppUpdateService(this.api);

  final ApiService api;

  Future<AppVersionInfo?> findUpdate() async {
    if (kIsWeb || !Platform.isAndroid) return null;

    final latest = await api.appVersion();
    if (!latest.hasDownload) return null;
    final current = await _currentVersion();
    if (_isNewer(latest, current)) return latest;
    return null;
  }

  Future<({String version, int versionCode})> _currentVersion() async {
    try {
      final info = await PackageInfo.fromPlatform();
      return (
        version: info.version,
        versionCode: int.tryParse(info.buildNumber) ?? AppConfig.versionCode,
      );
    } catch (_) {
      return (version: AppConfig.version, versionCode: AppConfig.versionCode);
    }
  }

  bool _isNewer(
    AppVersionInfo latest,
    ({String version, int versionCode}) current,
  ) {
    if (latest.versionCode > current.versionCode) return true;
    if (latest.versionCode < current.versionCode) return false;
    return _compareVersions(latest.version, current.version) > 0;
  }

  int _compareVersions(String left, String right) {
    final leftParts = _parts(left);
    final rightParts = _parts(right);
    final length = leftParts.length > rightParts.length
        ? leftParts.length
        : rightParts.length;

    for (var i = 0; i < length; i += 1) {
      final a = i < leftParts.length ? leftParts[i] : 0;
      final b = i < rightParts.length ? rightParts[i] : 0;
      if (a != b) return a.compareTo(b);
    }
    return 0;
  }

  List<int> _parts(String version) {
    return version
        .split(RegExp(r'[^0-9]+'))
        .where((part) => part.isNotEmpty)
        .map((part) => int.tryParse(part) ?? 0)
        .toList(growable: false);
  }
}
