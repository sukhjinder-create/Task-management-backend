import 'dart:io';

import 'api_client.dart';
import 'models.dart';

class ApiService {
  ApiService(this.client);

  final ApiClient client;

  Future<LoginResult> login(String email, String password) async {
    final data = await client.post(
      '/auth/login',
      auth: false,
      body: {'email': email, 'password': password},
    );
    return LoginResult.fromJson(Map<String, dynamic>.from(data as Map));
  }

  Future<AuthSession> verifyMfa(String token, String code) async {
    final data = await client.post(
      '/auth/mfa/verify',
      auth: false,
      body: {'mfa_session_token': token, 'code': code},
    );
    return AuthSession.fromJson(Map<String, dynamic>.from(data as Map));
  }

  Future<void> forgotPassword(String email) async {
    await client
        .post('/auth/forgot-password', auth: false, body: {'email': email});
  }

  Future<void> resetPassword(String token, String password) async {
    await client.post(
      '/auth/reset-password',
      auth: false,
      body: {'token': token, 'password': password},
    );
  }

  Future<AppVersionInfo> appVersion() async {
    final data = await client.get('/app-version', auth: false);
    return AppVersionInfo.fromJson(Map<String, dynamic>.from(data as Map));
  }

  Future<User> me() async {
    final data = await client.get('/users/me');
    return User.fromJson(Map<String, dynamic>.from(data as Map));
  }

  Future<void> uploadAvatar(File file) async {
    await client.multipart(
      '/users/me/avatar',
      fileField: 'avatar',
      file: file,
    );
  }

  Future<void> logout(String refreshToken) async {
    await client.post('/auth/logout', body: {'refreshToken': refreshToken});
  }

  Future<void> subscribePushToken({
    required String platform,
    required String fcmToken,
  }) async {
    await client.post(
      '/push/subscribe',
      body: {
        'platform': platform,
        'fcmToken': fcmToken,
      },
    );
  }

  Future<void> unsubscribePushToken(String fcmToken) async {
    await client.post('/push/unsubscribe', body: {'fcmToken': fcmToken});
  }

  Future<Map<String, dynamic>> dashboardOverview() async {
    return Map<String, dynamic>.from(
      await client.get('/dashboard/overview') as Map,
    );
  }

  Future<Map<String, dynamic>> dashboardExecutiveDetail() async {
    return Map<String, dynamic>.from(
      await client.get('/dashboard/executive-detail') as Map,
    );
  }

  Future<List<Project>> projects() async {
    final data = await client.get('/projects');
    return _list(data).map((item) => Project.fromJson(item)).toList();
  }

  Future<Project> project(String id) async {
    final data = await client.get('/projects/$id');
    return Project.fromJson(Map<String, dynamic>.from(data as Map));
  }

  Future<Project> saveProject({
    String? id,
    required String name,
    String? description,
    String? projectCode,
  }) async {
    final payload = {
      'name': name,
      'description': description,
      'project_code': projectCode,
    };
    final data = id == null
        ? await client.post('/projects', body: payload)
        : await client.put('/projects/$id', body: payload);
    return Project.fromJson(Map<String, dynamic>.from(data as Map));
  }

  Future<void> deleteProject(String id) async {
    await client.delete('/projects/$id');
  }

  Future<List<TaskItem>> allTasks() async {
    final data = await client.get('/tasks/all');
    return _list(data).map((item) => TaskItem.fromJson(item)).toList();
  }

  Future<List<TaskItem>> projectTasks(
    String projectId, {
    String? status,
    String? priority,
    String? assignedTo,
  }) async {
    final data = await client.get(
      '/tasks/$projectId',
      query: {
        'status': status,
        'priority': priority,
        'assigned_to': assignedTo,
      },
    );
    return _list(data).map((item) => TaskItem.fromJson(item)).toList();
  }

  Future<TaskItem> taskDetail(String taskId) async {
    final data = await client.get('/tasks/detail/$taskId');
    return TaskItem.fromJson(Map<String, dynamic>.from(data as Map));
  }

  Future<TaskItem> saveTask({
    String? id,
    required String projectId,
    required Map<String, dynamic> payload,
  }) async {
    final data = id == null
        ? await client.post('/tasks/$projectId', body: payload)
        : await client.put('/tasks/$id', body: payload);
    return TaskItem.fromJson(Map<String, dynamic>.from(data as Map));
  }

  Future<void> deleteTask(String id) async {
    await client.delete('/tasks/$id');
  }

  Future<List<CommentItem>> comments(String taskId) async {
    final data = await client.get('/comments/$taskId');
    return _list(data).map((item) => CommentItem.fromJson(item)).toList();
  }

  Future<void> addComment(String taskId, String comment) {
    return client.post(
      '/comments/$taskId',
      body: {'comment_text': comment},
    ).then((_) {});
  }

  Future<List<JsonMap>> subtasks(String taskId) async {
    return _list(await client.get('/subtasks/$taskId'));
  }

  Future<void> addSubtask(String taskId, String subtask) async {
    await client
        .post('/subtasks', body: {'task_id': taskId, 'subtask': subtask});
  }

  Future<List<JsonMap>> taskLogs(String taskId) async {
    return _list(await client.get('/tasks/$taskId/logs'));
  }

  Future<List<JsonMap>> taskAttachments(String taskId) async {
    return _list(await client.get('/tasks/$taskId/attachments'));
  }

  Future<void> uploadTaskAttachment(String taskId, File file) async {
    await client.multipart(
      '/tasks/$taskId/attachments',
      fileField: 'file',
      file: file,
    );
  }

  Future<List<NotificationItem>> notifications() async {
    final data = await client.get('/notifications');
    return _list(data).map((item) => NotificationItem.fromJson(item)).toList();
  }

  Future<void> markNotificationRead(String id) async {
    await client.post('/notifications/$id/read');
  }

  Future<void> markAllNotificationsRead() async {
    await client.post('/notifications/mark-all-read');
  }

  Future<JsonMap> notificationPreferences() async {
    final data = await client.get('/push/preferences');
    return data is Map ? JsonMap.from(data) : const {};
  }

  Future<JsonMap> updateNotificationPreferences({
    required bool muteAll,
    required bool muteTasks,
    required bool muteChat,
  }) async {
    final data = await client.patch(
      '/push/preferences',
      body: {
        'mute_all': muteAll,
        'mute_tasks': muteTasks,
        'mute_chat': muteChat,
      },
    );
    return data is Map ? JsonMap.from(data) : const {};
  }

  Future<void> attendance(
    String action, {
    Map<String, dynamic> body = const {},
  }) async {
    await client.post('/attendance/$action', body: body);
  }

  Future<List<ChatChannel>> channels() async {
    final data = await client.get('/chat/for-user');
    return _list(data).map((item) => ChatChannel.fromJson(item)).toList();
  }

  Future<List<ChatMessage>> channelMessages(String channelId) async {
    final data = await client.get('/chat/messages/for-channel/$channelId');
    return _list(data).map((item) => ChatMessage.fromJson(item)).toList();
  }

  Future<ChatChannel> createChannel({
    required String name,
    bool isPrivate = false,
    List<String> members = const [],
  }) async {
    final data = await client.post(
      '/chat/channels',
      body: {
        'name': name,
        'isPrivate': isPrivate,
        'members': members,
      },
    );
    return ChatChannel.fromJson(Map<String, dynamic>.from(data as Map));
  }

  Future<ChatChannel> updateChannel({
    required String channelId,
    required String name,
    bool isPrivate = false,
  }) async {
    final data = await client.put(
      '/chat/channels/$channelId',
      body: {
        'name': name,
        'isPrivate': isPrivate,
      },
    );
    return ChatChannel.fromJson(Map<String, dynamic>.from(data as Map));
  }

  Future<void> deleteChannel(String channelId) async {
    await client.delete('/chat/channels/$channelId');
  }

  Future<ChatMessage> sendMessage(
    String channelId,
    String message, {
    String? tempId,
    List<ChatAttachment> attachments = const [],
  }) async {
    final data = await client.post(
      '/chat/messages',
      body: {
        'channelId': channelId,
        'tempId': tempId,
        'encrypted': {
          'message': message,
          'fallbackText': message,
        },
        'fallbackText': message,
        'attachments':
            attachments.map((item) => item.toJson()).toList(growable: false),
      },
    );
    return ChatMessage.fromJson(Map<String, dynamic>.from(data as Map));
  }

  Future<ChatAttachment> uploadChatAttachment(File file) async {
    final data = await client.multipart(
      '/upload/chat-attachment',
      fileField: 'file',
      file: file,
    );
    return ChatAttachment.fromJson(Map<String, dynamic>.from(data as Map));
  }

  Future<Map<String, int>> unreadCounts() async {
    final data = await client.get('/chat/unread-counts');
    final source = data is Map ? data : const {};
    final counts = <String, int>{};
    for (final entry in source.entries) {
      final key = '${entry.key}';
      final value = entry.value;
      if (value is int) {
        counts[key] = value;
      } else {
        counts[key] = int.tryParse('$value') ?? 0;
      }
    }
    counts.removeWhere((_, value) => value <= 0);
    return counts;
  }

  Future<void> markChatRead(String channelId) async {
    await client.post('/chat/mark-read', body: {'channelKey': channelId});
  }

  Future<void> leaveChannel(String channelId) async {
    await client.post('/chat/channels/$channelId/leave');
  }

  Future<List<JsonMap>> channelAdmins(String channelId) async {
    return _list(await client.get('/chat/channels/$channelId/admins'));
  }

  Future<List<LeaveType>> leaveTypes() async {
    final data = await client.get('/leave/types');
    return _list(data).map(LeaveType.fromJson).toList(growable: false);
  }

  Future<List<LeaveRequest>> leaveRequests({
    String? status,
    String? userId,
  }) async {
    final data = await client.get(
      '/leave/requests',
      query: {
        'status': status,
        'userId': userId,
      },
    );
    return _list(data).map(LeaveRequest.fromJson).toList(growable: false);
  }

  Future<List<LeaveBalance>> leaveBalances({int? year, String? userId}) async {
    final data = await client.get(
      '/leave/balances',
      query: {
        'year': year,
        'userId': userId,
      },
    );
    return _list(data).map(LeaveBalance.fromJson).toList(growable: false);
  }

  Future<LeaveRequest> createLeaveRequest({
    required String leaveTypeId,
    required DateTime startDate,
    required DateTime endDate,
    String? reason,
  }) async {
    final data = await client.post(
      '/leave/requests',
      body: {
        'leave_type_id': leaveTypeId,
        'start_date': _dateOnly(startDate),
        'end_date': _dateOnly(endDate),
        'reason': reason,
      },
    );
    return LeaveRequest.fromJson(JsonMap.from(data as Map));
  }

  Future<void> cancelLeaveRequest(String requestId) async {
    await client.patch('/leave/requests/$requestId/cancel');
  }

  Future<void> reviewLeaveRequest({
    required String requestId,
    required String status,
    String? note,
  }) async {
    await client.patch(
      '/leave/requests/$requestId/review',
      body: {
        'status': status,
        'review_note': note,
      },
    );
  }

  Future<void> updateSubtask(String subtaskId, JsonMap payload) async {
    await client.put('/subtasks/$subtaskId', body: payload);
  }

  Future<void> deleteSubtask(String subtaskId) async {
    await client.delete('/subtasks/$subtaskId');
  }

  Future<void> deleteTaskAttachment(
    String taskId,
    String attachmentId,
  ) async {
    await client.delete('/tasks/$taskId/attachments/$attachmentId');
  }

  Future<List<JsonMap>> users({Map<String, dynamic>? query}) async {
    return _list(await client.get('/users', query: query));
  }

  Future<JsonMap> getMap(
    String path, {
    Map<String, dynamic>? query,
    bool auth = true,
  }) async {
    final data = await client.get(path, query: query, auth: auth);
    if (data is Map) return Map<String, dynamic>.from(data);
    return {'data': data};
  }

  Future<List<JsonMap>> getList(
    String path, {
    Map<String, dynamic>? query,
    bool auth = true,
  }) async {
    return _list(await client.get(path, query: query, auth: auth));
  }

  Future<JsonMap> postMap(String path, {Object? body, bool auth = true}) async {
    final data = await client.post(path, body: body, auth: auth);
    if (data is Map) return Map<String, dynamic>.from(data);
    return {'data': data};
  }

  Future<JsonMap> putMap(String path, {Object? body, bool auth = true}) async {
    final data = await client.put(path, body: body, auth: auth);
    if (data is Map) return Map<String, dynamic>.from(data);
    return {'data': data};
  }

  Future<JsonMap> patchMap(
    String path, {
    Object? body,
    bool auth = true,
  }) async {
    final data = await client.patch(path, body: body, auth: auth);
    if (data is Map) return Map<String, dynamic>.from(data);
    return {'data': data};
  }

  Future<void> delete(String path, {bool auth = true}) async {
    await client.delete(path, auth: auth);
  }

  List<JsonMap> _list(Object? data) {
    if (data is List) {
      return data
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .toList();
    }
    if (data is Map && data['data'] is List) {
      return (data['data'] as List)
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .toList();
    }
    if (data is Map && data['rows'] is List) {
      return (data['rows'] as List)
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .toList();
    }
    return const [];
  }

  String _dateOnly(DateTime value) {
    final year = value.year.toString().padLeft(4, '0');
    final month = value.month.toString().padLeft(2, '0');
    final day = value.day.toString().padLeft(2, '0');
    return '$year-$month-$day';
  }
}
