import 'package:flutter_test/flutter_test.dart';

import 'package:asystence_mobile/src/core/navigation_intent_service.dart';

void main() {
  group('NavigationIntentService.resolve', () {
    final service = NavigationIntentService();

    test('opens a task from a project notification action URL', () {
      final intent = service.resolve({
        'action_url': '/projects/project-1?task=task-7',
        'project_id': 'project-1',
        'task_id': 'task-7',
      });

      expect(intent?.kind, AppNavigationIntentKind.task);
      expect(intent?.taskId, 'task-7');
    });

    test('opens a project when the notification only targets a project', () {
      final intent = service.resolve({
        'action_url': '/projects/project-2',
      });

      expect(intent?.kind, AppNavigationIntentKind.project);
      expect(intent?.projectId, 'project-2');
    });

    test('opens chat from channel metadata', () {
      final intent = service.resolve({
        'type': 'chat_message',
        'channelId': 'general',
      });

      expect(intent?.kind, AppNavigationIntentKind.chat);
      expect(intent?.channelId, 'general');
    });

    test('opens chat from a chat action URL', () {
      final intent = service.resolve({
        'type': 'chat',
        'action_url': '/chat?channel=dm:user-1:user-2',
      });

      expect(intent?.kind, AppNavigationIntentKind.chat);
      expect(intent?.channelId, 'dm:user-1:user-2');
    });

    test('opens a task from nested notification metadata', () {
      final intent = service.resolve({
        'type': 'task_assigned',
        'metadata': {'taskId': 'task-99'},
      });

      expect(intent?.kind, AppNavigationIntentKind.task);
      expect(intent?.taskId, 'task-99');
    });

    test('opens a task from a direct task URL', () {
      final intent = service.resolve({
        'url': '/tasks/task-42',
      });

      expect(intent?.kind, AppNavigationIntentKind.task);
      expect(intent?.taskId, 'task-42');
    });
  });
}
