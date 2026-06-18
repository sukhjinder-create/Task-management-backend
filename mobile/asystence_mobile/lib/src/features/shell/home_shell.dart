import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/navigation_intent_service.dart';
import '../../state/app_scope.dart';
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
  int _chatInstanceKey = 0;
  StreamSubscription<AppNavigationIntent>? _intentSub;
  StreamSubscription<JsonMap>? _huddleSub;

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
        ),
      ),
      const _ShellTab(
        'Alerts',
        Icons.notifications_outlined,
        NotificationsScreen(),
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
    return Scaffold(
      key: _scaffoldKey,
      appBar: AppBar(
        title: Text(tabs[_index].label),
        actions: [
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
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (value) => setState(() => _index = value),
        destinations: [
          for (final tab in tabs)
            NavigationDestination(
              icon: Icon(tab.icon),
              selectedIcon: Icon(_selectedIcon(tab.icon)),
              label: tab.label,
            ),
        ],
      ),
      drawer: NavigationDrawer(
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

  void _handleIntent(AppNavigationIntent intent) {
    if (intent.kind == AppNavigationIntentKind.chat &&
        intent.channelId != null) {
      _openChat(intent.channelId!);
      return;
    }
    if (intent.kind == AppNavigationIntentKind.huddle &&
        intent.channelId != null &&
        intent.huddleId != null) {
      _openChat(intent.channelId!, huddleId: intent.huddleId);
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

  void _openChat(String channelId, {String? huddleId}) {
    setState(() {
      _chatChannelKey = channelId;
      _chatHuddleId = huddleId;
      _chatInstanceKey += 1;
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
      if (project == null) return;
      await Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => ProjectDetailScreen(project: project),
        ),
      );
    } catch (_) {}
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
              _openChat(channelId, huddleId: huddleId);
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
