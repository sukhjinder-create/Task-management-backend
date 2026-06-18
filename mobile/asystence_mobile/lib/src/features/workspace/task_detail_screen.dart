import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/formatters.dart';
import '../../core/models.dart';
import '../../core/ui.dart';
import '../../state/app_scope.dart';
import 'task_editor_sheet.dart';

class TaskDetailScreen extends StatefulWidget {
  const TaskDetailScreen({super.key, required this.taskId});

  final String taskId;

  @override
  State<TaskDetailScreen> createState() => _TaskDetailScreenState();
}

class _TaskDetailScreenState extends State<TaskDetailScreen> {
  late Future<_TaskBundle> _future;
  bool _ready = false;
  final _comment = TextEditingController();

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_ready) {
      _future = _load();
      _ready = true;
    }
  }

  Future<_TaskBundle> _load() async {
    final api = AppScope.of(context).api;
    final task = await api.taskDetail(widget.taskId);
    final results = await Future.wait<List<dynamic>>([
      api.comments(widget.taskId).catchError((_) => <CommentItem>[]),
      api.subtasks(widget.taskId).catchError((_) => <JsonMap>[]),
      api.taskLogs(widget.taskId).catchError((_) => <JsonMap>[]),
      api.taskAttachments(widget.taskId).catchError((_) => <JsonMap>[]),
    ]);
    return _TaskBundle(
      task: task,
      comments: results[0].cast<CommentItem>(),
      subtasks: results[1].cast<JsonMap>(),
      logs: results[2].cast<JsonMap>(),
      attachments: results[3].cast<JsonMap>(),
    );
  }

  Future<void> _refresh() async {
    setState(() => _future = _load());
    await _future;
  }

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Task detail'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _refresh,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: AsyncValueBuilder<_TaskBundle>(
          future: _future,
          builder: (context, bundle) {
            final task = bundle.task;
            final user = AppScope.of(context).auth.user;
            final canManage = user?.isAdmin == true || user?.isManager == true;
            final canUpdateStatus = canManage ||
                task.assignedTo == AppScope.of(context).auth.user?.id;
            return ListView(
              padding: const EdgeInsets.all(16),
              children: [
                SectionCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          if (task.displayId != null)
                            StatusChip(
                              label: task.displayId!,
                              tone: ChipTone.info,
                            ),
                          if (task.status != null)
                            StatusChip(
                              label: sentenceCase(task.status),
                              tone: task.isDone
                                  ? ChipTone.success
                                  : ChipTone.neutral,
                            ),
                          if (task.priority != null)
                            StatusChip(
                              label: sentenceCase(task.priority),
                              tone: task.priority == 'high'
                                  ? ChipTone.warning
                                  : ChipTone.neutral,
                            ),
                          if (task.isOverdue)
                            const StatusChip(
                              label: 'Overdue',
                              tone: ChipTone.danger,
                            ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Text(
                        task.title,
                        style: Theme.of(context)
                            .textTheme
                            .headlineSmall
                            ?.copyWith(fontWeight: FontWeight.w800),
                      ),
                      if (task.description != null &&
                          task.description!.trim().isNotEmpty) ...[
                        const SizedBox(height: 8),
                        Text(task.description!),
                      ],
                      const SizedBox(height: 12),
                      Row(
                        children: [
                          const Icon(Icons.folder_outlined, size: 18),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              task.projectName ?? task.projectId ?? 'Project',
                            ),
                          ),
                          const Icon(Icons.event_outlined, size: 18),
                          const SizedBox(width: 6),
                          Text(shortDate(task.dueDate)),
                        ],
                      ),
                      const SizedBox(height: 16),
                      _StatusActions(
                        task: task,
                        canUpdate: canUpdateStatus,
                        onChanged: _refresh,
                      ),
                      if (canManage) ...[
                        const SizedBox(height: 12),
                        Row(
                          children: [
                            Expanded(
                              child: OutlinedButton.icon(
                                onPressed: () => _editTask(task),
                                icon: const Icon(Icons.edit_outlined),
                                label: const Text('Edit'),
                              ),
                            ),
                            const SizedBox(width: 8),
                            IconButton.filledTonal(
                              tooltip: 'Delete task',
                              onPressed: _deleteTask,
                              icon: const Icon(Icons.delete_outline),
                            ),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                _ProgressCard(task: task, subtasks: bundle.subtasks),
                const SizedBox(height: 12),
                _CommentsCard(
                  comments: bundle.comments,
                  controller: _comment,
                  onSubmit: _addComment,
                ),
                const SizedBox(height: 12),
                _SubtasksCard(
                  taskId: widget.taskId,
                  subtasks: bundle.subtasks,
                  onChanged: _refresh,
                ),
                const SizedBox(height: 12),
                _AttachmentsCard(
                  taskId: widget.taskId,
                  attachments: bundle.attachments,
                  onUpload: _uploadAttachment,
                  onOpen: _openAttachment,
                  onDelete: canManage ? _deleteAttachment : null,
                ),
                const SizedBox(height: 12),
                _ActivityCard(logs: bundle.logs),
                const SizedBox(height: 40),
              ],
            );
          },
        ),
      ),
    );
  }

  Future<void> _addComment() async {
    final text = _comment.text.trim();
    if (text.isEmpty) return;
    try {
      await AppScope.of(context).api.addComment(widget.taskId, text);
      _comment.clear();
      if (mounted) showSnack(context, 'Comment added');
      await _refresh();
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    }
  }

  Future<void> _uploadAttachment() async {
    final api = AppScope.of(context).api;
    final pick = await FilePicker.platform.pickFiles();
    final path = pick?.files.single.path;
    if (path == null) return;
    try {
      await api.uploadTaskAttachment(widget.taskId, File(path));
      if (mounted) showSnack(context, 'Attachment uploaded');
      await _refresh();
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    }
  }

  Future<void> _editTask(TaskItem task) async {
    final api = AppScope.of(context).api;
    try {
      final users = await api.users();
      if (!mounted) return;
      final payload = await showTaskEditorSheet(
        context,
        task: task,
        users: users,
      );
      if (payload == null) return;
      await api.saveTask(
        id: task.id,
        projectId: task.projectId ?? '',
        payload: payload,
      );
      if (mounted) showSnack(context, 'Task updated');
      await _refresh();
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    }
  }

  Future<void> _deleteTask() async {
    final api = AppScope.of(context).api;
    final confirmed = await confirmAction(
      context,
      title: 'Delete task?',
      message: 'This task and its related content will be deleted.',
      confirmLabel: 'Delete',
    );
    if (!confirmed) return;
    try {
      await api.deleteTask(widget.taskId);
      if (!mounted) return;
      showSnack(context, 'Task deleted');
      Navigator.of(context).pop(true);
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    }
  }

  Future<void> _openAttachment(JsonMap attachment) async {
    final rawUrl = readString(attachment, ['url']);
    if (rawUrl == null) return;
    final baseUrl = await AppScope.of(context).client.baseUrl;
    final resolved = rawUrl.startsWith('http')
        ? rawUrl
        : '${baseUrl.replaceAll(RegExp(r'/+$'), '')}/${rawUrl.replaceFirst(RegExp(r'^/+'), '')}';
    final uri = Uri.tryParse(resolved);
    if (uri == null ||
        !await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      if (mounted) showSnack(context, 'Could not open attachment');
    }
  }

  Future<void> _deleteAttachment(JsonMap attachment) async {
    final id = readString(attachment, ['id']);
    if (id == null) return;
    final api = AppScope.of(context).api;
    final confirmed = await confirmAction(
      context,
      title: 'Delete attachment?',
      message: 'This file will be removed from the task.',
      confirmLabel: 'Delete',
    );
    if (!confirmed) return;
    try {
      await api.deleteTaskAttachment(widget.taskId, id);
      if (mounted) showSnack(context, 'Attachment deleted');
      await _refresh();
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    }
  }
}

class _TaskBundle {
  const _TaskBundle({
    required this.task,
    required this.comments,
    required this.subtasks,
    required this.logs,
    required this.attachments,
  });

  final TaskItem task;
  final List<CommentItem> comments;
  final List<JsonMap> subtasks;
  final List<JsonMap> logs;
  final List<JsonMap> attachments;
}

class _StatusActions extends StatelessWidget {
  const _StatusActions({
    required this.task,
    required this.canUpdate,
    required this.onChanged,
  });

  final TaskItem task;
  final bool canUpdate;
  final Future<void> Function() onChanged;

  @override
  Widget build(BuildContext context) {
    final statuses = ['pending', 'in-progress', 'completed'];
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final status in statuses)
          ChoiceChip(
            selected: task.status == status,
            label: Text(sentenceCase(status)),
            onSelected: !canUpdate || task.status == status
                ? null
                : (_) async {
                    try {
                      await AppScope.of(context).api.saveTask(
                        id: task.id,
                        projectId: task.projectId ?? '',
                        payload: {'status': status},
                      );
                      if (context.mounted) showSnack(context, 'Task updated');
                      await onChanged();
                    } catch (err) {
                      if (context.mounted) showSnack(context, '$err');
                    }
                  },
          ),
      ],
    );
  }
}

class _ProgressCard extends StatelessWidget {
  const _ProgressCard({required this.task, required this.subtasks});

  final TaskItem task;
  final List<JsonMap> subtasks;

  @override
  Widget build(BuildContext context) {
    final completed = task.completedSubtasks > 0
        ? task.completedSubtasks
        : subtasks
            .where((item) => '${item['status']}'.toLowerCase() == 'completed')
            .length;
    final total = task.totalSubtasks > 0 ? task.totalSubtasks : subtasks.length;
    final value = total == 0 ? 0.0 : completed / total;
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Progress', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 10),
          LinearProgressIndicator(value: value),
          const SizedBox(height: 8),
          Text('$completed of $total subtasks complete'),
        ],
      ),
    );
  }
}

class _CommentsCard extends StatelessWidget {
  const _CommentsCard({
    required this.comments,
    required this.controller,
    required this.onSubmit,
  });

  final List<CommentItem> comments;
  final TextEditingController controller;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Comments', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 12),
          TextField(
            controller: controller,
            minLines: 2,
            maxLines: 4,
            decoration: InputDecoration(
              hintText: 'Add a comment',
              suffixIcon: IconButton(
                onPressed: onSubmit,
                icon: const Icon(Icons.send),
              ),
            ),
          ),
          const SizedBox(height: 12),
          if (comments.isEmpty)
            const Text('No comments yet.')
          else
            for (final comment in comments)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const CircleAvatar(child: Icon(Icons.person)),
                title: Text(comment.author ?? 'Teammate'),
                subtitle: Text(comment.body),
                trailing: Text(longDateTime(comment.createdAt)),
              ),
        ],
      ),
    );
  }
}

class _SubtasksCard extends StatelessWidget {
  const _SubtasksCard({
    required this.taskId,
    required this.subtasks,
    required this.onChanged,
  });

  final String taskId;
  final List<JsonMap> subtasks;
  final Future<void> Function() onChanged;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'Subtasks',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              IconButton(
                tooltip: 'Add subtask',
                onPressed: () async {
                  final api = AppScope.of(context).api;
                  final payload = await showJsonFormSheet(
                    context,
                    title: 'Add subtask',
                    fields: const [
                      TextFieldSpec(
                        key: 'subtask',
                        label: 'Subtask',
                        isRequired: true,
                      ),
                    ],
                  );
                  if (payload == null) return;
                  try {
                    await api.addSubtask(taskId, '${payload['subtask']}');
                    if (context.mounted) showSnack(context, 'Subtask added');
                    await onChanged();
                  } catch (err) {
                    if (context.mounted) showSnack(context, '$err');
                  }
                },
                icon: const Icon(Icons.add),
              ),
            ],
          ),
          if (subtasks.isEmpty)
            const Text('No subtasks yet.')
          else
            for (final item in subtasks)
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                value: '${item['status']}'.toLowerCase() == 'completed',
                title: Text('${item['title'] ?? item['subtask'] ?? 'Subtask'}'),
                subtitle: item['priority'] == null
                    ? null
                    : Text('${item['priority']}'),
                secondary: PopupMenuButton<String>(
                  onSelected: (action) async {
                    final id = readString(item, ['id']);
                    if (id == null) return;
                    final api = AppScope.of(context).api;
                    if (action == 'edit') {
                      final payload = await showJsonFormSheet(
                        context,
                        title: 'Edit subtask',
                        fields: [
                          TextFieldSpec(
                            key: 'title',
                            label: 'Subtask',
                            initialValue:
                                '${item['title'] ?? item['subtask'] ?? ''}',
                            isRequired: true,
                          ),
                        ],
                      );
                      if (payload == null) return;
                      if (!context.mounted) return;
                      await api.updateSubtask(id, payload);
                      await onChanged();
                      return;
                    }
                    if (action == 'delete') {
                      final confirmed = await confirmAction(
                        context,
                        title: 'Delete subtask?',
                        message: 'This subtask will be removed.',
                        confirmLabel: 'Delete',
                      );
                      if (!confirmed) return;
                      if (!context.mounted) return;
                      await api.deleteSubtask(id);
                      await onChanged();
                    }
                  },
                  itemBuilder: (_) => const [
                    PopupMenuItem(value: 'edit', child: Text('Edit')),
                    PopupMenuItem(value: 'delete', child: Text('Delete')),
                  ],
                ),
                onChanged: (value) async {
                  try {
                    await AppScope.of(context).api.updateSubtask(
                      '${item['id']}',
                      {
                        'status': value == true ? 'completed' : 'pending',
                      },
                    );
                    await onChanged();
                  } catch (err) {
                    if (context.mounted) showSnack(context, '$err');
                  }
                },
              ),
        ],
      ),
    );
  }
}

class _AttachmentsCard extends StatelessWidget {
  const _AttachmentsCard({
    required this.taskId,
    required this.attachments,
    required this.onUpload,
    required this.onOpen,
    this.onDelete,
  });

  final String taskId;
  final List<JsonMap> attachments;
  final VoidCallback onUpload;
  final Future<void> Function(JsonMap attachment) onOpen;
  final Future<void> Function(JsonMap attachment)? onDelete;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'Attachments',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              IconButton(
                tooltip: 'Upload',
                onPressed: onUpload,
                icon: const Icon(Icons.attach_file),
              ),
            ],
          ),
          if (attachments.isEmpty)
            const Text('No attachments yet.')
          else
            for (final file in attachments)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.insert_drive_file_outlined),
                title: Text(
                  '${file['original_name'] ?? file['url'] ?? 'Attachment'}',
                ),
                subtitle: Text('${file['mime_type'] ?? ''}'),
                trailing: onDelete == null
                    ? const Icon(Icons.open_in_new)
                    : PopupMenuButton<String>(
                        onSelected: (action) {
                          if (action == 'open') onOpen(file);
                          if (action == 'delete') onDelete!(file);
                        },
                        itemBuilder: (_) => const [
                          PopupMenuItem(value: 'open', child: Text('Open')),
                          PopupMenuItem(
                            value: 'delete',
                            child: Text('Delete'),
                          ),
                        ],
                      ),
                onTap: () => onOpen(file),
              ),
        ],
      ),
    );
  }
}

class _ActivityCard extends StatelessWidget {
  const _ActivityCard({required this.logs});

  final List<JsonMap> logs;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Activity', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          if (logs.isEmpty)
            const Text('No activity yet.')
          else
            for (final log in logs.take(20))
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.history),
                title:
                    Text('${log['action'] ?? log['field_name'] ?? 'Updated'}'),
                subtitle:
                    Text('${log['actor_username'] ?? log['actor_id'] ?? ''}'),
              ),
        ],
      ),
    );
  }
}
