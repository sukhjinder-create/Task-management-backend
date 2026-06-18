import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:asystence_mobile/src/core/api_client.dart';
import 'package:asystence_mobile/src/core/api_service.dart';
import 'package:asystence_mobile/src/core/models.dart';
import 'package:asystence_mobile/src/core/session_store.dart';

void main() {
  late List<http.Request> requests;
  late ApiService api;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    requests = [];
    final client = ApiClient(
      defaultBaseUrl: 'https://api.example.test',
      sessionStore: SessionStore(),
      httpClient: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/leave/requests' && request.method == 'POST') {
          return http.Response(
            jsonEncode({
              'id': 'leave-1',
              'leave_type_id': 'annual',
              'leave_type_name': 'Annual',
              'start_date': '2026-06-20',
              'end_date': '2026-06-21',
              'status': 'pending',
              'days': 1,
            }),
            201,
            headers: {'content-type': 'application/json'},
          );
        }
        return http.Response(
          jsonEncode({'ok': true}),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
    client.sessionProvider = () => const AuthSession(
          token: 'access-token',
          refreshToken: 'refresh-token',
          user: User(
            id: 'user-1',
            username: 'Mobile User',
            workspaceId: 'workspace-1',
          ),
        );
    api = ApiService(client);
  });

  test('chat read state uses the backend channelKey contract', () async {
    await api.markChatRead('general');

    final request = requests.single;
    expect(request.method, 'POST');
    expect(request.url.path, '/chat/mark-read');
    expect(jsonDecode(request.body), {'channelKey': 'general'});
    expect(request.headers['authorization'], 'Bearer access-token');
    expect(request.headers['x-workspace-id'], 'workspace-1');
  });

  test('leave request sends date-only values and parses response', () async {
    final created = await api.createLeaveRequest(
      leaveTypeId: 'annual',
      startDate: DateTime(2026, 6, 20),
      endDate: DateTime(2026, 6, 21),
      reason: 'Family event',
    );

    final body = jsonDecode(requests.single.body) as Map<String, dynamic>;
    expect(body['start_date'], '2026-06-20');
    expect(body['end_date'], '2026-06-21');
    expect(body['leave_type_id'], 'annual');
    expect(created.id, 'leave-1');
    expect(created.status, 'pending');
  });

  test('notification preference update preserves all mute flags', () async {
    await api.updateNotificationPreferences(
      muteAll: false,
      muteTasks: true,
      muteChat: false,
    );

    final request = requests.single;
    expect(request.method, 'PATCH');
    expect(request.url.path, '/push/preferences');
    expect(jsonDecode(request.body), {
      'mute_all': false,
      'mute_tasks': true,
      'mute_chat': false,
    });
  });
}
