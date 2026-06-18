import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/ui.dart';
import '../../state/app_scope.dart';
import 'task_detail_screen.dart';
import 'task_editor_sheet.dart';

class ProjectsScreen extends StatefulWidget {
  const ProjectsScreen({super.key});

  @override
  State<ProjectsScreen> createState() => _ProjectsScreenState();
}

class _ProjectsScreenState extends State<ProjectsScreen> {
  late Future<List<Project>> _future;
  bool _ready = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_ready) {
      _future = AppScope.of(context).api.projects();
      _ready = true;
    }
  }

  Future<void> _refresh() async {
    setState(() => _future = AppScope.of(context).api.projects());
    await _future;
  }

  @override
  Widget build(BuildContext context) {
    final user = AppScope.of(context).auth.user;
    final canEdit = user?.isAdmin == true || user?.isManager == true;
    final canDelete = user?.isAdmin == true;
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: AsyncValueBuilder<List<Project>>(
          future: _future,
          builder: (context, projects) {
            if (projects.isEmpty) {
              return EmptyState(
                icon: Icons.folder_off_outlined,
                title: 'No projects yet',
                message: canEdit
                    ? 'Create your first project to organize work.'
                    : null,
                action: canEdit
                    ? FilledButton.icon(
                        onPressed: () => _editProject(),
                        icon: const Icon(Icons.add),
                        label: const Text('New project'),
                      )
                    : null,
              );
            }
            return ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: projects.length,
              separatorBuilder: (_, __) => const SizedBox(height: 8),
              itemBuilder: (context, index) {
                final project = projects[index];
                return ListTile(
                  tileColor: Theme.of(context).colorScheme.surface,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(8),
                  ),
                  leading: CircleAvatar(
                    child: Text(_initial(project.projectCode ?? project.name)),
                  ),
                  title: Text(project.name),
                  subtitle: Text(
                    project.description ??
                        project.projectCode ??
                        'Project workspace',
                  ),
                  trailing: canEdit
                      ? PopupMenuButton<String>(
                          onSelected: (action) {
                            if (action == 'edit') _editProject(project);
                            if (action == 'delete') _deleteProject(project);
                          },
                          itemBuilder: (_) => [
                            const PopupMenuItem(
                              value: 'edit',
                              child: Text('Edit'),
                            ),
                            if (canDelete)
                              const PopupMenuItem(
                                value: 'delete',
                                child: Text('Delete'),
                              ),
                          ],
                        )
                      : const Icon(Icons.chevron_right),
                  onTap: () => Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) => ProjectDetailScreen(project: project),
                    ),
                  ).then((_) => _refresh()),
                );
              },
            );
          },
        ),
      ),
      floatingActionButton: canEdit
          ? FloatingActionButton.extended(
              onPressed: () => _editProject(),
              icon: const Icon(Icons.add),
              label: const Text('Project'),
            )
          : null,
    );
  }

  Future<void> _editProject([Project? project]) async {
    final api = AppScope.of(context).api;
    final payload = await showJsonFormSheet(
      context,
      title: project == null ? 'New project' : 'Edit project',
      fields: [
        TextFieldSpec(
          key: 'name',
          label: 'Name',
          initialValue: project?.name,
          isRequired: true,
        ),
        TextFieldSpec(
          key: 'project_code',
          label: 'Project code',
          initialValue: project?.projectCode,
        ),
        TextFieldSpec(
          key: 'description',
          label: 'Description',
          initialValue: project?.description,
          minLines: 3,
          maxLines: 5,
        ),
      ],
    );
    if (payload == null) return;
    try {
      await api.saveProject(
        id: project?.id,
        name: '${payload['name']}',
        description: payload['description'] as String?,
        projectCode: payload['project_code'] as String?,
      );
      if (mounted) showSnack(context, 'Project saved');
      await _refresh();
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    }
  }

  Future<void> _deleteProject(Project project) async {
    final api = AppScope.of(context).api;
    final confirmed = await confirmAction(
      context,
      title: 'Delete project?',
      message: 'Delete "${project.name}" and its tasks? This cannot be undone.',
      confirmLabel: 'Delete',
    );
    if (!confirmed) return;
    try {
      await api.deleteProject(project.id);
      if (mounted) showSnack(context, 'Project deleted');
      await _refresh();
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    }
  }

  String _initial(String value) {
    final text = value.trim().isEmpty ? 'P' : value.trim();
    return text.substring(0, 1).toUpperCase();
  }
}

class ProjectDetailScreen extends StatefulWidget {
  const ProjectDetailScreen({super.key, required this.project});

  final Project project;

  @override
  State<ProjectDetailScreen> createState() => _ProjectDetailScreenState();
}

class _ProjectDetailScreenState extends State<ProjectDetailScreen> {
  late Future<List<TaskItem>> _future;
  bool _ready = false;
  String _status = 'all';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_ready) {
      _future = _load();
      _ready = true;
    }
  }

  Future<List<TaskItem>> _load() {
    return AppScope.of(context).api.projectTasks(
          widget.project.id,
          status: _status == 'all' ? null : _status,
        );
  }

  Future<void> _refresh() async {
    setState(() => _future = _load());
    await _future;
  }

  @override
  Widget build(BuildContext context) {
    final user = AppScope.of(context).auth.user;
    final canEdit = user?.isAdmin == true || user?.isManager == true;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.project.name),
        actions: [
          if (canEdit)
            IconButton(
              tooltip: 'Create task',
              onPressed: _createTask,
              icon: const Icon(Icons.add_task),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: AsyncValueBuilder<List<TaskItem>>(
          future: _future,
          builder: (context, tasks) {
            return ListView(
              padding: const EdgeInsets.all(16),
              children: [
                SectionCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        widget.project.name,
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      if (widget.project.description != null) ...[
                        const SizedBox(height: 6),
                        Text(widget.project.description!),
                      ],
                      const SizedBox(height: 12),
                      SegmentedButton<String>(
                        segments: const [
                          ButtonSegment(value: 'all', label: Text('All')),
                          ButtonSegment(value: 'pending', label: Text('Todo')),
                          ButtonSegment(
                            value: 'in-progress',
                            label: Text('Doing'),
                          ),
                          ButtonSegment(
                            value: 'completed',
                            label: Text('Done'),
                          ),
                        ],
                        selected: {_status},
                        onSelectionChanged: (value) {
                          setState(() {
                            _status = value.first;
                            _future = _load();
                          });
                        },
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                if (tasks.isEmpty)
                  const EmptyState(
                    icon: Icons.task_alt,
                    title: 'No tasks in this filter',
                  )
                else
                  for (final task in tasks)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: _TaskTile(task: task, onChanged: _refresh),
                    ),
              ],
            );
          },
        ),
      ),
      floatingActionButton: canEdit
          ? FloatingActionButton(
              onPressed: _createTask,
              child: const Icon(Icons.add),
            )
          : null,
    );
  }

  Future<void> _createTask() async {
    final api = AppScope.of(context).api;
    try {
      final users = await api.users();
      if (!mounted) return;
      final payload = await showTaskEditorSheet(context, users: users);
      if (payload == null) return;
      await api.saveTask(projectId: widget.project.id, payload: payload);
      if (mounted) showSnack(context, 'Task created');
      await _refresh();
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    }
  }
}

class _TaskTile extends StatelessWidget {
  const _TaskTile({required this.task, required this.onChanged});

  final TaskItem task;
  final Future<void> Function() onChanged;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      tileColor: Theme.of(context).colorScheme.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      leading:
          Icon(task.isDone ? Icons.check_circle : Icons.radio_button_unchecked),
      title: Text(task.title),
      subtitle: Text(
        [
          if (task.displayId != null) task.displayId,
          if (task.status != null) task.status,
          if (task.priority != null) task.priority,
        ].join(' | '),
      ),
      trailing: task.isOverdue
          ? const StatusChip(label: 'Overdue', tone: ChipTone.danger)
          : const Icon(Icons.chevron_right),
      onTap: () => Navigator.push(
        context,
        MaterialPageRoute(builder: (_) => TaskDetailScreen(taskId: task.id)),
      ).then((_) => onChanged()),
    );
  }
}
