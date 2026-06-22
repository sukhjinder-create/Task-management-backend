import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/formatters.dart';
import '../../core/models.dart';
import '../../core/navigation_intent_service.dart';
import '../../core/ui.dart';
import '../../state/app_scope.dart';
import '../../state/theme_store.dart';
import '../workspace/chat_screen.dart';
import '../workspace/dashboard_screen.dart';
import '../workspace/leave_screen.dart';
import '../workspace/notifications_screen.dart';
import '../workspace/profile_screen.dart';
import '../workspace/projects_screen.dart';
import '../workspace/task_detail_screen.dart';
import '../workspace/tasks_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  int _index = 0;
  String? _chatChannelKey;
  String? _chatHuddleId;
  JsonMap? _chatHuddleData;
  int _chatInstanceKey = 0;
  bool _chatImmersive = false;
  StreamSubscription<AppNavigationIntent>? _intentSub;
  StreamSubscription<JsonMap>? _huddleSub;
  String _attendanceStatus = 'offline';
  bool _attendanceBusy = false;

  static const _attendanceStorageKey = 'asystence.attendance.status';

  List<_ShellTab> get _tabs {
    final role = AppScope.of(context).auth.user?.role;
    final tasksLabel = role == 'user' ? 'My Tasks' : 'Tasks';
    return [
      const _ShellTab('Home', Icons.dashboard_outlined, DashboardScreen()),
      const _ShellTab('Projects', Icons.folder_copy_outlined, ProjectsScreen()),
      _ShellTab(tasksLabel, Icons.checklist_outlined, const TasksScreen()),
      _ShellTab(
        'Chat',
        Icons.chat_bubble_outline,
        ChatScreen(
          key: ValueKey('chat-$_chatInstanceKey-${_chatChannelKey ?? 'home'}'),
          initialChannelKey: _chatChannelKey,
          initialHuddleId: _chatHuddleId,
          initialHuddleData: _chatHuddleData,
          onImmersiveChanged: (value) {
            if (!mounted || _chatImmersive == value) return;
            setState(() => _chatImmersive = value);
          },
        ),
      ),
      _ShellTab(
        'Alerts',
        Icons.notifications_outlined,
        NotificationsScreen(onOpen: _openNotification),
      ),
    ];
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final scope = AppScope.of(context);
      _intentSub = scope.navigationIntents.stream.listen(_handleIntent);
      for (final intent in scope.navigationIntents.takePending()) {
        _handleIntent(intent);
      }
      _huddleSub = scope.socket.huddles.listen((event) {
        if (event['event'] != 'started') return;
        final startedBy = event['startedBy'];
        final startedById = startedBy is Map
            ? readString(JsonMap.from(startedBy), ['userId', 'user_id'])
            : null;
        if (startedById == scope.auth.user?.id) return;
        _showIncomingHuddle(event);
      });
      unawaited(_restoreAttendanceStatus());
    });
  }

  @override
  void dispose() {
    _intentSub?.cancel();
    _huddleSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = AppScope.of(context).auth;
    final user = auth.user;
    final tabs = _tabs;
    final chatImmersive = _index == 3 && _chatImmersive;
    return Scaffold(
      key: _scaffoldKey,
      appBar: chatImmersive
          ? null
          : AppBar(
              title: Text(tabs[_index].label),
              actions: [
                TextButton.icon(
                  onPressed: _attendanceBusy ? null : _openAttendanceMenu,
                  icon: Icon(_attendanceIcon, size: 18),
                  label: Text(_attendanceLabel),
                ),
                IconButton(
                  tooltip: 'Appearance',
                  onPressed: _openThemePicker,
                  icon: const Icon(Icons.palette_outlined),
                ),
                IconButton(
                  tooltip: 'More',
                  onPressed: _openMore,
                  icon: const Icon(Icons.more_horiz),
                ),
              ],
            ),
      body: IndexedStack(
        index: _index,
        children: tabs.map((tab) => tab.screen).toList(growable: false),
      ),
      bottomNavigationBar: chatImmersive
          ? null
          : NavigationBar(
              selectedIndex: _index,
              onDestinationSelected: (value) => setState(() {
                _index = value;
                if (value != 3) _chatImmersive = false;
              }),
              destinations: [
                for (final tab in tabs)
                  NavigationDestination(
                    icon: Icon(tab.icon),
                    selectedIcon: Icon(_selectedIcon(tab.icon)),
                    label: tab.label,
                  ),
              ],
            ),
      drawer: chatImmersive
          ? null
          : NavigationDrawer(
              selectedIndex: null,
              children: [
                UserAccountsDrawerHeader(
                  accountName: Text(user?.displayName ?? 'Asystence'),
                  accountEmail: Text(user?.email ?? user?.role ?? ''),
                  currentAccountPicture: CircleAvatar(
                    child: Text(_initial(user?.displayName)),
                  ),
                ),
                _drawerItem(
                  context,
                  'Profile',
                  Icons.person_outline,
                  const ProfileScreen(),
                ),
                _drawerItem(
                  context,
                  'Leave',
                  Icons.event_available_outlined,
                  const LeaveScreen(),
                ),
                ListTile(
                  leading: const Icon(Icons.palette_outlined),
                  title: const Text('Appearance'),
                  subtitle: Text(AppScope.of(context).themes.selection.label),
                  onTap: () {
                    Navigator.pop(context);
                    _openThemePicker();
                  },
                ),
                const Divider(),
                ListTile(
                  leading: const Icon(Icons.logout),
                  title: const Text('Sign out'),
                  onTap: () {
                    Navigator.pop(context);
                    auth.logout();
                  },
                ),
              ],
            ),
    );
  }

  ListTile _drawerItem(
    BuildContext context,
    String title,
    IconData icon,
    Widget screen,
  ) {
    return ListTile(
      leading: Icon(icon),
      title: Text(title),
      onTap: () {
        Navigator.pop(context);
        Navigator.of(context).push(MaterialPageRoute(builder: (_) => screen));
      },
    );
  }

  void _openMore() {
    _scaffoldKey.currentState?.openDrawer();
  }

  Future<void> _restoreAttendanceStatus() async {
    final preferences = await SharedPreferences.getInstance();
    final value = preferences.getString(_attendanceStorageKey);
    if (!mounted || value == null) return;
    if (!{'offline', 'available', 'aws', 'lunch'}.contains(value)) return;
    setState(() => _attendanceStatus = value);
  }

  String get _attendanceLabel {
    switch (_attendanceStatus) {
      case 'available':
        return 'Available';
      case 'aws':
        return 'AWS';
      case 'lunch':
        return 'Lunch';
      default:
        return 'Sign in';
    }
  }

  IconData get _attendanceIcon {
    switch (_attendanceStatus) {
      case 'available':
        return Icons.check_circle_outline;
      case 'aws':
        return Icons.timer_outlined;
      case 'lunch':
        return Icons.restaurant_outlined;
      default:
        return Icons.login;
    }
  }

  Future<void> _openAttendanceMenu() async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Attendance',
                style: Theme.of(sheetContext).textTheme.titleLarge,
              ),
              const SizedBox(height: 4),
              Text(
                'Current status: $_attendanceLabel',
                style: Theme.of(sheetContext).textTheme.bodySmall,
              ),
              const SizedBox(height: 16),
              if (_attendanceStatus == 'offline')
                FilledButton.icon(
                  onPressed: () {
                    Navigator.pop(sheetContext);
                    unawaited(_updateAttendance('sign-in'));
                  },
                  icon: const Icon(Icons.login),
                  label: const Text('Sign in'),
                )
              else ...[
                if (_attendanceStatus == 'available') ...[
                  OutlinedButton.icon(
                    onPressed: () {
                      Navigator.pop(sheetContext);
                      unawaited(_updateAttendance('lunch'));
                    },
                    icon: const Icon(Icons.restaurant_outlined),
                    label: const Text('Start lunch break'),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Away from system',
                    style: Theme.of(sheetContext).textTheme.labelLarge,
                  ),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final minutes in const [15, 30, 60])
                        ActionChip(
                          avatar: const Icon(Icons.timer_outlined, size: 17),
                          label: Text('AWS $minutes min'),
                          onPressed: () {
                            Navigator.pop(sheetContext);
                            unawaited(
                              _updateAttendance(
                                'aws',
                                body: {'minutes': minutes},
                              ),
                            );
                          },
                        ),
                    ],
                  ),
                ],
                if (_attendanceStatus == 'aws' || _attendanceStatus == 'lunch')
                  FilledButton.icon(
                    onPressed: () {
                      Navigator.pop(sheetContext);
                      unawaited(_updateAttendance('available'));
                    },
                    icon: const Icon(Icons.play_arrow),
                    label: const Text('Mark available'),
                  ),
                const SizedBox(height: 10),
                TextButton.icon(
                  onPressed: () {
                    Navigator.pop(sheetContext);
                    unawaited(_updateAttendance('sign-off'));
                  },
                  icon: const Icon(Icons.logout),
                  label: const Text('Sign off'),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _updateAttendance(
    String action, {
    JsonMap body = const {},
  }) async {
    if (_attendanceBusy) return;
    setState(() => _attendanceBusy = true);
    try {
      await AppScope.of(context).api.attendance(action, body: body);
      final nextStatus = switch (action) {
        'sign-in' || 'available' => 'available',
        'aws' => 'aws',
        'lunch' => 'lunch',
        _ => 'offline',
      };
      final preferences = await SharedPreferences.getInstance();
      await preferences.setString(_attendanceStorageKey, nextStatus);
      if (!mounted) return;
      setState(() => _attendanceStatus = nextStatus);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Attendance updated: $_attendanceLabel')),
      );
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not update attendance: $error')),
      );
    } finally {
      if (mounted) setState(() => _attendanceBusy = false);
    }
  }

  Future<void> _openThemePicker() async {
    final themes = AppScope.of(context).themes;
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              title: const Text('Appearance'),
              subtitle:
                  const Text('Choose how Asystence looks on this device.'),
              trailing: const Icon(Icons.palette_outlined),
            ),
            for (final option in AppThemeOption.values)
              ListTile(
                title: Text(option.label),
                leading: Icon(_themeIcon(option)),
                trailing: option == themes.selection
                    ? const Icon(Icons.check_circle)
                    : const Icon(Icons.circle_outlined),
                onTap: () {
                  unawaited(themes.select(option));
                  Navigator.pop(sheetContext);
                },
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  IconData _themeIcon(AppThemeOption option) {
    switch (option) {
      case AppThemeOption.system:
        return Icons.brightness_auto_outlined;
      case AppThemeOption.light:
        return Icons.light_mode_outlined;
      case AppThemeOption.dark:
        return Icons.dark_mode_outlined;
      default:
        return Icons.color_lens_outlined;
    }
  }

  void _handleIntent(AppNavigationIntent intent) {
    if (intent.kind == AppNavigationIntentKind.chat &&
        intent.channelId != null) {
      _openChat(intent.channelId!);
      return;
    }
    if (intent.kind == AppNavigationIntentKind.huddle &&
        intent.channelId != null &&
        intent.huddleId != null) {
      _openChat(
        intent.channelId!,
        huddleId: intent.huddleId,
        huddleData: intent.data,
      );
      return;
    }
    if (intent.kind == AppNavigationIntentKind.task) {
      _openTask(intent.taskId);
      return;
    }
    if (intent.kind == AppNavigationIntentKind.project &&
        intent.projectId != null) {
      _openProject(intent.projectId!);
      return;
    }
    if (intent.kind == AppNavigationIntentKind.notifications) {
      setState(() => _index = 4);
      return;
    }
    if (intent.kind == AppNavigationIntentKind.leave) {
      Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => const LeaveScreen()),
      );
    }
  }

  void _openNotification(NotificationItem notification) {
    final intent = AppScope.of(context).navigationIntents.resolve({
      ...notification.raw,
      if (notification.url != null) 'url': notification.url,
    });
    if (intent != null &&
        intent.kind != AppNavigationIntentKind.notifications) {
      _handleIntent(intent);
    } else {
      unawaited(_showNotificationDetails(notification));
    }
  }

  Future<void> _showNotificationDetails(NotificationItem notification) async {
    final type = readString(notification.raw, [
      'type',
      'category',
      'event',
      'event_type',
    ]);
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      builder: (context) {
        final scheme = Theme.of(context).colorScheme;
        final created = longDateTime(notification.createdAt);
        return SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    CircleAvatar(
                      backgroundColor: scheme.primaryContainer,
                      foregroundColor: scheme.onPrimaryContainer,
                      child: Icon(
                        notification.read
                            ? Icons.notifications_none
                            : Icons.notifications_active_outlined,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            notification.title,
                            style: Theme.of(context)
                                .textTheme
                                .titleLarge
                                ?.copyWith(fontWeight: FontWeight.w800),
                          ),
                          if (created.isNotEmpty) ...[
                            const SizedBox(height: 4),
                            Text(
                              created,
                              style: Theme.of(context)
                                  .textTheme
                                  .bodySmall
                                  ?.copyWith(
                                    color: scheme.onSurfaceVariant,
                                  ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ],
                ),
                if (notification.body != null &&
                    notification.body!.trim().isNotEmpty) ...[
                  const SizedBox(height: 18),
                  Text(
                    notification.body!,
                    style: Theme.of(context).textTheme.bodyLarge,
                  ),
                ],
                if (type != null && type.trim().isNotEmpty) ...[
                  const SizedBox(height: 16),
                  Chip(
                    avatar: const Icon(Icons.info_outline, size: 18),
                    label: Text(type),
                  ),
                ],
                const SizedBox(height: 20),
                Text(
                  'This alert did not include a task, project, chat, or leave target, so it opens here for review.',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                ),
                const SizedBox(height: 18),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('Done'),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  void _openChat(
    String channelId, {
    String? huddleId,
    JsonMap? huddleData,
  }) {
    setState(() {
      _chatChannelKey = channelId;
      _chatHuddleId = huddleId;
      _chatHuddleData = huddleData;
      _chatInstanceKey += 1;
      _chatImmersive = true;
      _index = 3;
    });
  }

  void _openTask(String? taskId) {
    setState(() => _index = 2);
    if (taskId == null || taskId.trim().isEmpty) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => TaskDetailScreen(taskId: taskId)),
      );
    });
  }

  void _openProject(String projectId) {
    setState(() => _index = 1);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(_pushProject(projectId));
    });
  }

  Future<void> _pushProject(String projectId) async {
    try {
      final projects = await AppScope.of(context).api.projects();
      if (!mounted) return;
      final project = projects.cast<Project?>().firstWhere(
            (item) => item?.id == projectId,
            orElse: () => null,
          );
      if (project == null) {
        showSnack(context, 'Project is no longer available.');
        return;
      }
      await Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => ProjectDetailScreen(project: project),
        ),
      );
    } catch (_) {
      if (mounted) showSnack(context, 'Could not open project.');
    }
  }

  Future<void> _showIncomingHuddle(JsonMap data) async {
    if (!mounted) return;
    final channelId = readString(data, ['channelId', 'channel_id']);
    final huddleId = readString(data, ['huddleId', 'huddle_id']);
    if (channelId == null || huddleId == null) return;
    final startedBy = data['startedBy'];
    final startedByName = startedBy is Map
        ? readString(JsonMap.from(startedBy), ['username', 'name'])
        : readString(data, ['startedByName', 'started_by_name']);
    final initiatorUserId = startedBy is Map
        ? readString(JsonMap.from(startedBy), ['userId', 'user_id'])
        : readString(data, ['startedBy', 'started_by']);
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Incoming huddle'),
        content: Text('${startedByName ?? 'Someone'} is calling in chat.'),
        actions: [
          TextButton(
            onPressed: () {
              AppScope.of(context).socket.declineHuddle(
                    channelId: channelId,
                    huddleId: huddleId,
                    initiatorUserId: initiatorUserId,
                  );
              Navigator.of(context).pop();
            },
            child: const Text('Decline'),
          ),
          FilledButton.icon(
            onPressed: () {
              Navigator.of(context).pop();
              _openChat(
                channelId,
                huddleId: huddleId,
                huddleData: data,
              );
            },
            icon: const Icon(Icons.call),
            label: const Text('Open call'),
          ),
        ],
      ),
    );
  }

  IconData _selectedIcon(IconData icon) {
    if (icon == Icons.dashboard_outlined) return Icons.dashboard;
    if (icon == Icons.folder_copy_outlined) return Icons.folder_copy;
    if (icon == Icons.checklist_outlined) return Icons.checklist;
    if (icon == Icons.chat_bubble_outline) return Icons.chat_bubble;
    if (icon == Icons.notifications_outlined) return Icons.notifications;
    return icon;
  }

  String _initial(String? value) {
    final text = (value == null || value.trim().isEmpty) ? 'A' : value.trim();
    return text.substring(0, 1).toUpperCase();
  }
}

class _ShellTab {
  const _ShellTab(this.label, this.icon, this.screen);

  final String label;
  final IconData icon;
  final Widget screen;
}
