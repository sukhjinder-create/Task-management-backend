import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../../../config/app_config.dart';

typedef HuddleIceBaseUrlProvider = Future<String> Function();

class HuddleIceConfigService {
  HuddleIceConfigService({
    HuddleIceBaseUrlProvider? apiBaseUrlProvider,
    http.Client? httpClient,
  })  : _apiBaseUrlProvider = apiBaseUrlProvider ?? _defaultApiBaseUrl,
        _httpClient = httpClient ?? http.Client(),
        _ownsHttpClient = httpClient == null;

  final HuddleIceBaseUrlProvider _apiBaseUrlProvider;
  final http.Client _httpClient;
  final bool _ownsHttpClient;

  Map<String, dynamic>? _cachedRtcConfiguration;
  Future<Map<String, dynamic>>? _fetchInFlight;

  Future<Map<String, dynamic>> getRtcConfiguration() {
    final cached = _cachedRtcConfiguration;
    if (cached != null) return Future.value(cached);

    _fetchInFlight ??= _fetchRtcConfiguration().whenComplete(() {
      _fetchInFlight = null;
    });
    return _fetchInFlight!;
  }

  void dispose() {
    if (_ownsHttpClient) _httpClient.close();
  }

  Future<Map<String, dynamic>> _fetchRtcConfiguration() async {
    try {
      final baseUrl =
          (await _apiBaseUrlProvider()).trim().replaceAll(RegExp(r'/+$'), '');
      if (baseUrl.isEmpty) {
        return _useFallback('empty backend base URL');
      }

      final response = await _httpClient.get(
        Uri.parse('$baseUrl/ice-servers'),
        headers: const {'Accept': 'application/json'},
      ).timeout(const Duration(seconds: 5));

      if (response.statusCode < 200 || response.statusCode >= 300) {
        debugPrint(
          '[huddle:ice:mobile] fetch failed: HTTP ${response.statusCode}',
        );
        return _useFallback('backend returned HTTP ${response.statusCode}');
      }

      final decoded = jsonDecode(response.body);
      if (decoded is! Map) {
        return _useFallback('malformed payload: root is not an object');
      }

      final iceServers = _normalizeIceServers(decoded['iceServers']);
      if (iceServers.isEmpty) {
        return _useFallback('malformed payload: iceServers missing or empty');
      }

      final config = <String, dynamic>{'iceServers': iceServers};
      _cachedRtcConfiguration = config;
      debugPrint(
        '[huddle:ice:mobile] backend ICE fetched: ${iceServers.length} servers',
      );
      return config;
    } catch (err) {
      debugPrint('[huddle:ice:mobile] fetch failed: $err');
      return _useFallback('fetch failure');
    }
  }

  Map<String, dynamic> _useFallback(String reason) {
    final config = fallbackRtcConfiguration();
    _cachedRtcConfiguration = config;
    debugPrint('[huddle:ice:mobile] fallback ICE used: $reason');
    return config;
  }

  static Future<String> _defaultApiBaseUrl() async => AppConfig.apiBaseUrl;

  static Map<String, dynamic> fallbackRtcConfiguration() {
    return {
      'iceServers': [
        {'urls': 'stun:stun.l.google.com:19302'},
        {'urls': 'stun:stun1.l.google.com:19302'},
        {'urls': 'stun:stun.relay.metered.ca:80'},
        {
          'urls': [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp',
            'turn:openrelay.metered.ca:80?transport=tcp',
          ],
          'username': 'openrelayproject',
          'credential': 'openrelayproject',
        },
      ],
    };
  }

  static List<Map<String, dynamic>> _normalizeIceServers(Object? raw) {
    if (raw is! List) return const [];

    final servers = <Map<String, dynamic>>[];
    for (final item in raw) {
      if (item is! Map) continue;

      final server = Map<String, dynamic>.from(item);
      final urls = server['urls'];
      if (urls is String && urls.trim().isNotEmpty) {
        servers.add(server);
      } else if (urls is List) {
        final normalizedUrls = urls
            .whereType<String>()
            .where((url) => url.trim().isNotEmpty)
            .toList(growable: false);
        if (normalizedUrls.isEmpty) continue;
        server['urls'] = normalizedUrls;
        servers.add(server);
      }
    }

    return servers;
  }
}
