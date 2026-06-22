import 'dart:convert';

typedef JsonMap = Map<String, dynamic>;

class AppVersionInfo {
  AppVersionInfo({
    required this.platform,
    required this.packageName,
    required this.version,
    required this.versionCode,
    required this.apkUrl,
    required this.mandatory,
    this.checksum,
    this.notes,
  });

  factory AppVersionInfo.fromJson(JsonMap json) {
    return AppVersionInfo(
      platform: readString(json, ['platform']) ?? 'android',
      packageName: readString(json, ['packageName', 'package_name']) ?? '',
      version: readString(json, ['version']) ?? '',
      versionCode: readInt(json, ['versionCode', 'version_code']) ?? 0,
      apkUrl: readString(json, ['apkUrl', 'apk_url']) ?? '',
      mandatory: readBool(json, ['mandatory', 'force'], fallback: false),
      checksum: readString(json, ['checksum', 'sha256']),
      notes: readString(json, ['notes', 'releaseNotes', 'release_notes']),
    );
  }

  final String platform;
  final String packageName;
  final String version;
  final int versionCode;
  final String apkUrl;
  final bool mandatory;
  final String? checksum;
  final String? notes;

  bool get hasDownload => apkUrl.trim().isNotEmpty;
}

String? readString(Map<String, dynamic> json, List<String> keys) {
  for (final key in keys) {
    final value = json[key];
    if (value != null && '$value'.trim().isNotEmpty) return '$value';
  }
  return null;
}

int? readInt(Map<String, dynamic> json, List<String> keys) {
  for (final key in keys) {
    final value = json[key];
    if (value is int) return value;
    if (value is num) return value.toInt();
    if (value is String) return int.tryParse(value);
  }
  return null;
}

double? readDouble(Map<String, dynamic> json, List<String> keys) {
  for (final key in keys) {
    final value = json[key];
    if (value is double) return value;
    if (value is num) return value.toDouble();
    if (value is String) return double.tryParse(value);
  }
  return null;
}

bool readBool(
  Map<String, dynamic> json,
  List<String> keys, {
  bool fallback = false,
}) {
  for (final key in keys) {
    final value = json[key];
    if (value is bool) return value;
    if (value is num) return value != 0;
    if (value is String) {
      final lower = value.toLowerCase();
      if (['true', '1', 'yes'].contains(lower)) return true;
      if (['false', '0', 'no'].contains(lower)) return false;
    }
  }
  return fallback;
}

List<dynamic> readList(Map<String, dynamic> json, List<String> keys) {
  for (final key in keys) {
    final value = json[key];
    if (value is List) return value;
  }
  return const [];
}

class ApiException implements Exception {
  ApiException(this.message, {this.statusCode, this.details});

  final String message;
  final int? statusCode;
  final Object? details;

  @override
  String toString() => 'ApiException($statusCode): $message';
}

class User {
  const User({
    required this.id,
    required this.username,
    this.email,
    this.role = 'user',
    this.workspaceId,
    this.avatarUrl,
    this.projects = const [],
    this.raw = const {},
  });

  final String id;
  final String username;
  final String? email;
  final String role;
  final String? workspaceId;
  final String? avatarUrl;
  final List<String> projects;
  final JsonMap raw;

  bool get isAdmin => role == 'admin' || role == 'owner';
  bool get isManager => role == 'manager';

  String get displayName {
    if (username.trim().isNotEmpty) return username;
    if (email != null && email!.trim().isNotEmpty) return email!;
    return 'User';
  }

  factory User.fromJson(Map<String, dynamic> json) {
    final projects = readList(json, ['projects'])
        .map((item) => '$item')
        .where((item) => item.isNotEmpty)
        .toList(growable: false);

    return User(
      id: readString(json, ['id', 'user_id']) ?? '',
      username: readString(json, ['username', 'name', 'full_name']) ?? '',
      email: readString(json, ['email']),
      role: readString(json, ['role']) ?? 'user',
      workspaceId: readString(json, ['workspaceId', 'workspace_id']),
      avatarUrl: readString(json, ['avatarUrl', 'avatar_url', 'picture']),
      projects: projects,
      raw: JsonMap.from(json),
    );
  }

  JsonMap toJson() => {
        ...raw,
        'id': id,
        'username': username,
        'email': email,
        'role': role,
        'workspaceId': workspaceId,
        'avatar_url': avatarUrl,
        'projects': projects,
      };
}

class AuthSession {
  const AuthSession({
    required this.token,
    required this.refreshToken,
    required this.user,
  });

  final String token;
  final String refreshToken;
  final User user;

  factory AuthSession.fromJson(Map<String, dynamic> json) {
    final userJson = json['user'];
    return AuthSession(
      token: readString(json, ['token', 'accessToken']) ?? '',
      refreshToken: readString(json, ['refreshToken', 'refresh_token']) ?? '',
      user: userJson is Map<String, dynamic>
          ? User.fromJson(userJson)
          : User.fromJson(json),
    );
  }

  AuthSession copyWith({
    String? token,
    String? refreshToken,
    User? user,
  }) {
    return AuthSession(
      token: token ?? this.token,
      refreshToken: refreshToken ?? this.refreshToken,
      user: user ?? this.user,
    );
  }

  JsonMap toJson() => {
        'token': token,
        'refreshToken': refreshToken,
        'user': user.toJson(),
      };
}

class LoginResult {
  const LoginResult({
    this.session,
    this.mfaRequired = false,
    this.mfaSessionToken,
    this.message,
  });

  final AuthSession? session;
  final bool mfaRequired;
  final String? mfaSessionToken;
  final String? message;

  factory LoginResult.fromJson(Map<String, dynamic> json) {
    final mfaRequired = readBool(json, ['mfa_required', 'mfaRequired']);
    return LoginResult(
      session: mfaRequired ? null : AuthSession.fromJson(json),
      mfaRequired: mfaRequired,
      mfaSessionToken:
          readString(json, ['mfa_session_token', 'mfaSessionToken']),
      message: readString(json, ['message']),
    );
  }
}

class Project {
  const Project({
    required this.id,
    required this.name,
    this.description,
    this.projectCode,
    this.raw = const {},
  });

  final String id;
  final String name;
  final String? description;
  final String? projectCode;
  final JsonMap raw;

  factory Project.fromJson(Map<String, dynamic> json) => Project(
        id: readString(json, ['id']) ?? '',
        name: readString(json, ['name', 'title']) ?? 'Untitled project',
        description: readString(json, ['description']),
        projectCode: readString(json, ['project_code', 'code']),
        raw: JsonMap.from(json),
      );
}

class TaskItem {
  const TaskItem({
    required this.id,
    required this.title,
    this.projectId,
    this.projectName,
    this.displayId,
    this.status,
    this.priority,
    this.assignedTo,
    this.assigneeName,
    this.dueDate,
    this.description,
    this.completedSubtasks = 0,
    this.totalSubtasks = 0,
    this.raw = const {},
  });

  final String id;
  final String title;
  final String? projectId;
  final String? projectName;
  final String? displayId;
  final String? status;
  final String? priority;
  final String? assignedTo;
  final String? assigneeName;
  final DateTime? dueDate;
  final String? description;
  final int completedSubtasks;
  final int totalSubtasks;
  final JsonMap raw;

  bool get isDone =>
      ['done', 'completed', 'closed'].contains(status?.toLowerCase());
  bool get isOverdue =>
      dueDate != null && !isDone && dueDate!.isBefore(DateTime.now());

  factory TaskItem.fromJson(Map<String, dynamic> json) {
    final dueRaw = readString(json, ['due_date', 'dueDate']);
    return TaskItem(
      id: readString(json, ['id']) ?? '',
      title: readString(json, ['task', 'title', 'name']) ?? 'Untitled task',
      projectId: readString(json, ['project_id', 'projectId']),
      projectName: readString(json, ['project_name', 'projectName']),
      displayId: readString(json, ['display_id', 'ticket_id']),
      status: readString(json, ['status']),
      priority: readString(json, ['priority']),
      assignedTo: readString(json, ['assigned_to', 'assignedTo']),
      assigneeName: readString(
        json,
        ['assignee_name', 'assigned_to_username', 'username'],
      ),
      dueDate: dueRaw == null ? null : DateTime.tryParse(dueRaw),
      description: readString(json, ['description']),
      completedSubtasks:
          readInt(json, ['subtasks_completed', 'completed_subtasks']) ?? 0,
      totalSubtasks: readInt(json, ['subtasks_total', 'total_subtasks']) ?? 0,
      raw: JsonMap.from(json),
    );
  }
}

class CommentItem {
  const CommentItem({
    required this.id,
    required this.body,
    this.author,
    this.createdAt,
    this.raw = const {},
  });

  final String id;
  final String body;
  final String? author;
  final DateTime? createdAt;
  final JsonMap raw;

  factory CommentItem.fromJson(Map<String, dynamic> json) => CommentItem(
        id: readString(json, ['id']) ?? '',
        body: readString(
              json,
              ['comment_text', 'comment', 'body', 'text', 'content'],
            ) ??
            '',
        author: readString(json, ['username', 'author', 'created_by_username']),
        createdAt: DateTime.tryParse(
          readString(json, ['created_at', 'createdAt']) ?? '',
        ),
        raw: JsonMap.from(json),
      );
}

class ChatChannel {
  const ChatChannel({
    required this.id,
    required this.key,
    required this.name,
    this.type,
    this.isPrivate = false,
    this.raw = const {},
  });

  final String id;
  final String key;
  final String name;
  final String? type;
  final bool isPrivate;
  final JsonMap raw;

  bool get isReadOnly => key == 'availability-updates';
  bool get isDm => type == 'dm' || key.startsWith('dm:');
  String get openKey => key.isNotEmpty ? key : id;

  factory ChatChannel.fromJson(Map<String, dynamic> json) {
    final key = readString(json, ['key', 'channel_key', 'channelKey']) ??
        readString(json, ['id', 'channel_id']) ??
        '';
    return ChatChannel(
      id: readString(json, ['id', 'channel_id']) ?? key,
      key: key,
      name: readString(json, ['name', 'title', 'channel_name']) ??
          _nameFromKey(key),
      type: readString(json, ['type', 'channel_type']),
      isPrivate: readBool(json, ['isPrivate', 'is_private'], fallback: false),
      raw: JsonMap.from(json),
    );
  }

  static String _nameFromKey(String key) {
    if (key == 'availability-updates') return 'Availability updates';
    if (key.startsWith('dm:')) return 'Direct message';
    if (key.trim().isEmpty) return 'Channel';
    return key.replaceAll('-', ' ');
  }
}

class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.text,
    this.channelId,
    this.senderId,
    this.senderName,
    this.senderAvatarUrl,
    this.createdAt,
    this.attachments = const [],
    this.raw = const {},
  });

  final String id;
  final String text;
  final String? channelId;
  final String? senderId;
  final String? senderName;
  final String? senderAvatarUrl;
  final DateTime? createdAt;
  final List<ChatAttachment> attachments;
  final JsonMap raw;

  factory ChatMessage.fromJson(Map<String, dynamic> json) => ChatMessage(
        id: readString(json, ['id', 'messageId']) ?? '',
        text: _cleanMessageText(
          readString(json, [
                'fallbackText',
                'fallback_text',
                'message',
                'text',
                'body',
                'content',
                'textHtml',
                'text_html',
              ]) ??
              '',
        ),
        channelId: readString(json, ['channel_key', 'channel_id', 'channelId']),
        senderId:
            readString(json, ['sender_id', 'senderId', 'user_id', 'userId']),
        senderName: readString(json, ['sender_name', 'username', 'name']),
        senderAvatarUrl: readString(
          json,
          ['avatarUrl', 'avatar_url', 'sender_avatar_url', 'picture'],
        ),
        createdAt: DateTime.tryParse(
          readString(json, ['created_at', 'createdAt']) ?? '',
        ),
        attachments: readList(json, ['attachments'])
            .whereType<Map>()
            .map(
              (item) =>
                  ChatAttachment.fromJson(Map<String, dynamic>.from(item)),
            )
            .toList(growable: false),
        raw: JsonMap.from(json),
      );

  String get stableKey {
    final tempId = readString(raw, ['tempId', 'temp_id']);
    if (id.isNotEmpty) return id;
    if (tempId != null) return tempId;
    return '${channelId ?? ''}:${senderId ?? ''}:${createdAt?.toIso8601String() ?? ''}:$text';
  }

  bool get hasBody => text.trim().isNotEmpty;

  JsonMap? get huddleCall {
    final direct = raw['huddleCall'];
    if (direct is Map) return JsonMap.from(direct);
    for (final key in ['encrypted', 'encrypted_json']) {
      Object? envelope = raw[key];
      if (envelope is String && envelope.trim().isNotEmpty) {
        try {
          envelope = jsonDecode(envelope);
        } catch (_) {
          envelope = null;
        }
      }
      if (envelope is Map &&
          envelope['__huddle_call_log'] == true &&
          envelope['huddleCall'] is Map) {
        return JsonMap.from(envelope['huddleCall'] as Map);
      }
    }
    return null;
  }
}

String _cleanMessageText(String value) {
  var text = value.trim();
  if (text.startsWith('{') && text.contains('fallbackText')) {
    try {
      final decoded = jsonDecode(text);
      if (decoded is Map && decoded['fallbackText'] != null) {
        text = '${decoded['fallbackText']}';
      }
    } catch (_) {}
  }
  return text.replaceAll(RegExp(r'<[^>]+>'), '').trim();
}

class ChatAttachment {
  const ChatAttachment({
    required this.url,
    required this.name,
    this.type,
    this.size,
    this.raw = const {},
  });

  final String url;
  final String name;
  final String? type;
  final int? size;
  final JsonMap raw;

  bool get isImage =>
      (type ?? '').toLowerCase().startsWith('image/') ||
      RegExp(r'\.(png|jpe?g|gif|webp)$', caseSensitive: false).hasMatch(url);

  factory ChatAttachment.fromJson(Map<String, dynamic> json) {
    final url =
        readString(json, ['url', 'file_url', 'downloadUrl', 'download_url']) ??
            '';
    return ChatAttachment(
      url: url,
      name: readString(
            json,
            ['name', 'original_name', 'filename', 'file_name'],
          ) ??
          (url.isEmpty
              ? 'Attachment'
              : Uri.tryParse(url)?.pathSegments.last ?? 'Attachment'),
      type: readString(json, ['type', 'mime_type', 'mimetype', 'contentType']),
      size: readInt(json, ['size', 'file_size', 'bytes']),
      raw: JsonMap.from(json),
    );
  }

  JsonMap toJson() => {
        ...raw,
        'url': url,
        'name': name,
        'type': type,
        'size': size,
      };
}

class NotificationItem {
  const NotificationItem({
    required this.id,
    required this.title,
    this.body,
    this.read = false,
    this.url,
    this.createdAt,
    this.raw = const {},
  });

  final String id;
  final String title;
  final String? body;
  final bool read;
  final String? url;
  final DateTime? createdAt;
  final JsonMap raw;

  factory NotificationItem.fromJson(Map<String, dynamic> json) =>
      NotificationItem(
        id: readString(json, ['id']) ?? '',
        title: readString(json, ['title', 'type']) ?? 'Notification',
        body: readString(json, ['body', 'message', 'content']),
        read: readBool(json, ['is_read', 'read']),
        url: readString(json, ['url', 'deep_link', 'action_url']),
        createdAt: DateTime.tryParse(
          readString(json, ['created_at', 'createdAt']) ?? '',
        ),
        raw: JsonMap.from(json),
      );
}

class LeaveType {
  const LeaveType({
    required this.id,
    required this.name,
    required this.color,
    this.maxDays,
    this.requiresDocument = false,
    this.raw = const {},
  });

  final String id;
  final String name;
  final String color;
  final double? maxDays;
  final bool requiresDocument;
  final JsonMap raw;

  factory LeaveType.fromJson(JsonMap json) => LeaveType(
        id: readString(json, ['id']) ?? '',
        name: readString(json, ['name']) ?? 'Leave',
        color: readString(json, ['color']) ?? '#6366f1',
        maxDays: readDouble(json, ['max_days', 'maxDays']),
        requiresDocument: readBool(
          json,
          ['requires_doc', 'requiresDocument'],
        ),
        raw: JsonMap.from(json),
      );
}

class LeaveRequest {
  const LeaveRequest({
    required this.id,
    required this.leaveTypeId,
    required this.leaveTypeName,
    required this.startDate,
    required this.endDate,
    required this.status,
    this.days = 0,
    this.reason,
    this.requesterName,
    this.reviewNote,
    this.createdAt,
    this.raw = const {},
  });

  final String id;
  final String leaveTypeId;
  final String leaveTypeName;
  final DateTime? startDate;
  final DateTime? endDate;
  final String status;
  final double days;
  final String? reason;
  final String? requesterName;
  final String? reviewNote;
  final DateTime? createdAt;
  final JsonMap raw;

  bool get canCancel => status.toLowerCase() == 'pending';
  bool get isPending => status.toLowerCase() == 'pending';

  factory LeaveRequest.fromJson(JsonMap json) => LeaveRequest(
        id: readString(json, ['id']) ?? '',
        leaveTypeId: readString(json, ['leave_type_id', 'leaveTypeId']) ?? '',
        leaveTypeName:
            readString(json, ['leave_type_name', 'leaveTypeName']) ?? 'Leave',
        startDate: DateTime.tryParse(
          readString(json, ['start_date', 'startDate']) ?? '',
        ),
        endDate: DateTime.tryParse(
          readString(json, ['end_date', 'endDate']) ?? '',
        ),
        status: readString(json, ['status']) ?? 'pending',
        days: readDouble(json, ['days']) ?? 0,
        reason: readString(json, ['reason']),
        requesterName: readString(json, ['username', 'requester_name']),
        reviewNote: readString(json, ['review_note', 'reviewNote']),
        createdAt: DateTime.tryParse(
          readString(json, ['created_at', 'createdAt']) ?? '',
        ),
        raw: JsonMap.from(json),
      );
}

class LeaveBalance {
  const LeaveBalance({
    required this.leaveTypeId,
    required this.name,
    this.allocated = 0,
    this.used = 0,
    this.color = '#6366f1',
    this.raw = const {},
  });

  final String leaveTypeId;
  final String name;
  final double allocated;
  final double used;
  final String color;
  final JsonMap raw;

  double get remaining => (allocated - used).clamp(0, double.infinity);

  factory LeaveBalance.fromJson(JsonMap json) => LeaveBalance(
        leaveTypeId: readString(json, ['leave_type_id', 'leaveTypeId']) ?? '',
        name: readString(json, ['name', 'leave_type_name']) ?? 'Leave',
        allocated: readDouble(json, ['allocated']) ?? 0,
        used: readDouble(json, ['used']) ?? 0,
        color: readString(json, ['color']) ?? '#6366f1',
        raw: JsonMap.from(json),
      );
}
