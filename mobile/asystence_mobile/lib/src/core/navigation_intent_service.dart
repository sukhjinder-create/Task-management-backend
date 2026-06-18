import 'dart:async';

import 'models.dart';

class NavigationIntentService {
  final StreamController<AppNavigationIntent> _controller =
      StreamController<AppNavigationIntent>.broadcast();
  final List<AppNavigationIntent> _pending = [];

  Stream<AppNavigationIntent> get stream => _controller.stream;

  List<AppNavigationIntent> takePending() {
    final items = List<AppNavigationIntent>.from(_pending);
    _pending.clear();
    return items;
  }

  void openChat(String channelId) {
    if (channelId.trim().isEmpty) return;
    _emit(AppNavigationIntent.chat(channelId));
  }

  void openHuddle(JsonMap data) {
    final channelId = readString(data, ['channelId', 'channel_id']);
    final huddleId = readString(data, ['huddleId', 'huddle_id']);
    if (channelId == null || huddleId == null) return;
    _emit(
      AppNavigationIntent.huddle(
        channelId: channelId,
        huddleId: huddleId,
        data: data,
      ),
    );
  }

  void openTask(String? taskId) {
    _emit(AppNavigationIntent.task(taskId));
  }

  void openProject(String projectId) {
    if (projectId.trim().isEmpty) return;
    _emit(AppNavigationIntent.project(projectId));
  }

  void openNotifications() {
    _emit(
      const AppNavigationIntent._(
        kind: AppNavigationIntentKind.notifications,
      ),
    );
  }

  void openLeave() {
    _emit(
      const AppNavigationIntent._(
        kind: AppNavigationIntentKind.leave,
      ),
    );
  }

  void fromPushData(Map<String, dynamic> data) {
    final intent = resolve(data);
    if (intent != null) _emit(intent);
  }

  AppNavigationIntent? resolve(Map<String, dynamic> data) {
    final urlData = _fieldsFromUrl(
      readString(data, ['url', 'deep_link', 'action_url']),
    );
    final enriched = <String, dynamic>{...urlData, ...data};
    final type = readString(enriched, ['type']);
    if (type == 'huddle') {
      final channelId = readString(enriched, ['channelId', 'channel_id']);
      final huddleId = readString(enriched, ['huddleId', 'huddle_id']);
      if (channelId == null || huddleId == null) return null;
      return AppNavigationIntent.huddle(
        channelId: channelId,
        huddleId: huddleId,
        data: enriched,
      );
    }
    final channelId =
        readString(enriched, ['channelId', 'channel_id', 'channelKey']);
    if (channelId != null) {
      return AppNavigationIntent.chat(channelId);
    }
    final taskId = readString(enriched, ['taskId', 'task_id', 'task']);
    if (taskId != null) {
      return AppNavigationIntent.task(taskId);
    }
    final projectId =
        readString(enriched, ['projectId', 'project_id', 'project']);
    if (projectId != null) {
      return AppNavigationIntent.project(projectId);
    }
    if (urlData['screen'] == 'tasks') {
      return AppNavigationIntent.task(null);
    }
    if (urlData['screen'] == 'leave') {
      return const AppNavigationIntent._(
        kind: AppNavigationIntentKind.leave,
      );
    }
    if (urlData['screen'] == 'notifications') {
      return const AppNavigationIntent._(
        kind: AppNavigationIntentKind.notifications,
      );
    }
    return null;
  }

  JsonMap _fieldsFromUrl(String? rawUrl) {
    if (rawUrl == null || rawUrl.trim().isEmpty) return const {};
    try {
      final uri = _parseUrl(rawUrl);
      final data = <String, dynamic>{};
      final channel = uri.queryParameters['channel'];
      final huddle =
          uri.queryParameters['huddleId'] ?? uri.queryParameters['huddle'];
      final task = uri.queryParameters['task'] ?? uri.queryParameters['taskId'];
      if (channel != null) data['channelId'] = channel;
      if (huddle != null) {
        data['huddleId'] = huddle;
        data['type'] = 'huddle';
      }
      if (task != null) data['taskId'] = task;
      final segments = uri.pathSegments;
      if (segments.isNotEmpty &&
          segments.first == 'projects' &&
          segments.length > 1) {
        data['projectId'] = segments[1];
      } else if (segments.isNotEmpty && segments.first == 'my-tasks') {
        data['screen'] = 'tasks';
      } else if (segments.isNotEmpty && segments.first == 'notifications') {
        data['screen'] = 'notifications';
      } else if (segments.isNotEmpty && segments.first == 'leave') {
        data['screen'] = 'leave';
      }
      return data;
    } catch (_) {
      return const {};
    }
  }

  Uri _parseUrl(String rawUrl) {
    final trimmed = rawUrl.trim();
    final absolute = Uri.tryParse(trimmed);
    if (absolute != null && absolute.hasScheme) return absolute;
    return Uri.parse('https://app.asystence.com$trimmed');
  }

  void _emit(AppNavigationIntent intent) {
    if (!_controller.hasListener) _pending.add(intent);
    _controller.add(intent);
  }
}

class AppNavigationIntent {
  const AppNavigationIntent._({
    required this.kind,
    this.channelId,
    this.huddleId,
    this.taskId,
    this.projectId,
    this.data = const {},
  });

  factory AppNavigationIntent.chat(String channelId) => AppNavigationIntent._(
        kind: AppNavigationIntentKind.chat,
        channelId: channelId,
      );

  factory AppNavigationIntent.huddle({
    required String channelId,
    required String huddleId,
    required JsonMap data,
  }) =>
      AppNavigationIntent._(
        kind: AppNavigationIntentKind.huddle,
        channelId: channelId,
        huddleId: huddleId,
        data: data,
      );

  factory AppNavigationIntent.task(String? taskId) =>
      AppNavigationIntent._(kind: AppNavigationIntentKind.task, taskId: taskId);

  factory AppNavigationIntent.project(String projectId) =>
      AppNavigationIntent._(
        kind: AppNavigationIntentKind.project,
        projectId: projectId,
      );

  final AppNavigationIntentKind kind;
  final String? channelId;
  final String? huddleId;
  final String? taskId;
  final String? projectId;
  final JsonMap data;
}

enum AppNavigationIntentKind {
  chat,
  huddle,
  task,
  project,
  notifications,
  leave,
}
