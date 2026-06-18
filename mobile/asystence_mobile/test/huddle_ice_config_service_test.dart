import 'dart:convert';

import 'package:asystence_mobile/src/features/workspace/huddle_media/huddle_ice_config_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('fetches ICE configuration from backend', () async {
    final service = HuddleIceConfigService(
      apiBaseUrlProvider: () async => 'https://api.example.test/',
      httpClient: MockClient((request) async {
        expect(request.url.toString(), 'https://api.example.test/ice-servers');
        return http.Response(
          jsonEncode({
            'iceServers': [
              {'urls': 'stun:backend.example.test:19302'},
            ],
          }),
          200,
        );
      }),
    );
    addTearDown(service.dispose);

    final config = await service.getRtcConfiguration();

    expect(
      config,
      {
        'iceServers': [
          {'urls': 'stun:backend.example.test:19302'},
        ],
      },
    );
  });

  test('uses fallback ICE configuration when backend is unavailable', () async {
    final service = HuddleIceConfigService(
      apiBaseUrlProvider: () async => 'https://api.example.test',
      httpClient: MockClient(
        (request) async => http.Response('unavailable', 503),
      ),
    );
    addTearDown(service.dispose);

    final config = await service.getRtcConfiguration();

    expect(config, HuddleIceConfigService.fallbackRtcConfiguration());
  });

  test('uses fallback ICE configuration for malformed backend payload',
      () async {
    final service = HuddleIceConfigService(
      apiBaseUrlProvider: () async => 'https://api.example.test',
      httpClient: MockClient((request) async {
        return http.Response(jsonEncode({'iceServers': []}), 200);
      }),
    );
    addTearDown(service.dispose);

    final config = await service.getRtcConfiguration();

    expect(config, HuddleIceConfigService.fallbackRtcConfiguration());
  });
}
