import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/formatters.dart';
import '../../core/models.dart';
import '../../core/ui.dart';
import '../../state/app_scope.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key, this.onOpen});

  final ValueChanged<NotificationItem>? onOpen;

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  late Future<List<NotificationItem>> _future;
  bool _ready = false;
  StreamSubscription<JsonMap>? _socketSub;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _socketSub = AppScope.of(context).socket.notifications.listen((_) {
        if (_ready) unawaited(_refresh());
      });
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_ready) {
      _future = AppScope.of(context).api.notifications();
      _ready = true;
    }
  }

  Future<void> _refresh() async {
    setState(() => _future = AppScope.of(context).api.notifications());
    await _future;
  }

  @override
  void dispose() {
    _socketSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: AsyncValueBuilder<List<NotificationItem>>(
          future: _future,
          builder: (context, notifications) {
            if (notifications.isEmpty) {
              return const EmptyState(
                icon: Icons.notifications_none,
                title: 'No notifications',
                message:
                    'Important project and chat updates will show up here.',
              );
            }
            return ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: notifications.length,
              separatorBuilder: (_, __) => const SizedBox(height: 8),
              itemBuilder: (context, index) {
                final item = notifications[index];
                return ListTile(
                  tileColor: Theme.of(context).colorScheme.surface,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(8),
                  ),
                  leading: Icon(
                    item.read
                        ? Icons.notifications_none
                        : Icons.notifications_active,
                  ),
                  title: Text(item.title),
                  subtitle: Text(
                    [
                      if (item.body != null) item.body,
                      longDateTime(item.createdAt),
                    ]
                        .whereType<String>()
                        .where((value) => value.isNotEmpty)
                        .join('\n'),
                  ),
                  isThreeLine: item.body != null,
                  trailing: item.read
                      ? null
                      : const StatusChip(label: 'New', tone: ChipTone.info),
                  onTap: () async {
                    final scope = AppScope.of(context);
                    if (!item.read) {
                      try {
                        await scope.api.markNotificationRead(item.id);
                      } catch (_) {
                        if (context.mounted) {
                          showSnack(
                            context,
                            'Could not mark notification as read',
                          );
                        }
                      }
                    }
                    if (widget.onOpen != null) {
                      widget.onOpen!(item);
                    } else {
                      scope.navigationIntents.fromPushData({
                        ...item.raw,
                        if (item.url != null) 'url': item.url,
                      });
                    }
                    await _refresh();
                  },
                );
              },
            );
          },
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          await AppScope.of(context).api.markAllNotificationsRead();
          await _refresh();
        },
        icon: const Icon(Icons.done_all),
        label: const Text('Read all'),
      ),
    );
  }
}
