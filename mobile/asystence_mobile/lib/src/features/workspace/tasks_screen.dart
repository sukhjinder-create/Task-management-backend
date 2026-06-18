import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/ui.dart';
import '../../state/app_scope.dart';
import 'task_detail_screen.dart';

class TasksScreen extends StatefulWidget {
  const TasksScreen({super.key});

  @override
  State<TasksScreen> createState() => _TasksScreenState();
}

class _TasksScreenState extends State<TasksScreen> {
  late Future<List<TaskItem>> _future;
  bool _ready = false;
  final _search = TextEditingController();
  String _mode = 'mine';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_ready) {
      _mode = AppScope.of(context).auth.user?.role == 'user' ? 'mine' : 'all';
      _future = AppScope.of(context).api.allTasks();
      _ready = true;
    }
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    setState(() => _future = AppScope.of(context).api.allTasks());
    await _future;
  }

  @override
  Widget build(BuildContext context) {
    final userId = AppScope.of(context).auth.user?.id;
    return RefreshIndicator(
      onRefresh: _refresh,
      child: AsyncValueBuilder<List<TaskItem>>(
        future: _future,
        builder: (context, tasks) {
          var visible = tasks;
          if (_mode == 'mine' && userId != null) {
            visible =
                visible.where((task) => task.assignedTo == userId).toList();
          } else if (_mode == 'overdue') {
            visible = visible.where((task) => task.isOverdue).toList();
          } else if (_mode == 'done') {
            visible = visible.where((task) => task.isDone).toList();
          }
          final term = _search.text.trim().toLowerCase();
          if (term.isNotEmpty) {
            visible = visible
                .where(
                  (task) =>
                      task.title.toLowerCase().contains(term) ||
                      (task.projectName ?? '').toLowerCase().contains(term) ||
                      (task.displayId ?? '').toLowerCase().contains(term),
                )
                .toList();
          }

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              TextField(
                controller: _search,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search),
                  labelText: 'Search tasks',
                ),
              ),
              const SizedBox(height: 12),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'mine', label: Text('Mine')),
                  ButtonSegment(value: 'all', label: Text('All')),
                  ButtonSegment(value: 'overdue', label: Text('Late')),
                  ButtonSegment(value: 'done', label: Text('Done')),
                ],
                selected: {_mode},
                onSelectionChanged: (value) =>
                    setState(() => _mode = value.first),
              ),
              const SizedBox(height: 12),
              if (visible.isEmpty)
                const EmptyState(
                  icon: Icons.task_alt,
                  title: 'No matching tasks',
                )
              else
                for (final task in visible)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: ListTile(
                      tileColor: Theme.of(context).colorScheme.surface,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                      leading: Icon(
                        task.isDone
                            ? Icons.check_circle
                            : Icons.circle_outlined,
                      ),
                      title: Text(task.title),
                      subtitle: Text(
                        '${task.projectName ?? 'Project'} • ${task.status ?? 'pending'}',
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (_) => TaskDetailScreen(taskId: task.id),
                        ),
                      ).then((_) => _refresh()),
                    ),
                  ),
            ],
          );
        },
      ),
    );
  }
}
