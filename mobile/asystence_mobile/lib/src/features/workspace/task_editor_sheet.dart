import 'package:flutter/material.dart';

import '../../core/formatters.dart';
import '../../core/models.dart';
import '../../core/ui.dart';

Future<JsonMap?> showTaskEditorSheet(
  BuildContext context, {
  TaskItem? task,
  required List<JsonMap> users,
}) {
  return showModalBottomSheet<JsonMap>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (_) => _TaskEditorSheet(task: task, users: users),
  );
}

class _TaskEditorSheet extends StatefulWidget {
  const _TaskEditorSheet({required this.task, required this.users});

  final TaskItem? task;
  final List<JsonMap> users;

  @override
  State<_TaskEditorSheet> createState() => _TaskEditorSheetState();
}

class _TaskEditorSheetState extends State<_TaskEditorSheet> {
  late final _title = TextEditingController(text: widget.task?.title);
  late final _description =
      TextEditingController(text: widget.task?.description);
  late String _status = widget.task?.status ?? 'pending';
  late String _priority = widget.task?.priority ?? 'medium';
  late String? _assignedTo = widget.task?.assignedTo;
  late DateTime? _dueDate = widget.task?.dueDate;

  @override
  void dispose() {
    _title.dispose();
    _description.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final knownUserIds = widget.users
        .map((user) => readString(user, ['id', 'user_id']))
        .whereType<String>()
        .toSet();
    if (_assignedTo != null && !knownUserIds.contains(_assignedTo)) {
      _assignedTo = null;
    }

    return Padding(
      padding: EdgeInsets.fromLTRB(
        16,
        0,
        16,
        MediaQuery.viewInsetsOf(context).bottom + 16,
      ),
      child: ListView(
        shrinkWrap: true,
        children: [
          Text(
            widget.task == null ? 'New task' : 'Edit task',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _title,
            autofocus: widget.task == null,
            decoration: const InputDecoration(labelText: 'Task *'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _description,
            minLines: 3,
            maxLines: 6,
            decoration: const InputDecoration(labelText: 'Description'),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: DropdownButtonFormField<String>(
                  initialValue: _status,
                  decoration: const InputDecoration(labelText: 'Status'),
                  items: const [
                    DropdownMenuItem(
                      value: 'pending',
                      child: Text('Pending'),
                    ),
                    DropdownMenuItem(
                      value: 'in-progress',
                      child: Text('In progress'),
                    ),
                    DropdownMenuItem(
                      value: 'completed',
                      child: Text('Completed'),
                    ),
                  ],
                  onChanged: (value) {
                    if (value != null) setState(() => _status = value);
                  },
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: DropdownButtonFormField<String>(
                  initialValue: _priority,
                  decoration: const InputDecoration(labelText: 'Priority'),
                  items: const [
                    DropdownMenuItem(value: 'low', child: Text('Low')),
                    DropdownMenuItem(value: 'medium', child: Text('Medium')),
                    DropdownMenuItem(value: 'high', child: Text('High')),
                    DropdownMenuItem(value: 'urgent', child: Text('Urgent')),
                  ],
                  onChanged: (value) {
                    if (value != null) setState(() => _priority = value);
                  },
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String?>(
            initialValue: _assignedTo,
            decoration: const InputDecoration(labelText: 'Assignee'),
            items: [
              const DropdownMenuItem<String?>(
                value: null,
                child: Text('Unassigned'),
              ),
              for (final user in widget.users)
                DropdownMenuItem<String?>(
                  value: readString(user, ['id', 'user_id']),
                  child: Text(
                    readString(user, ['username', 'name', 'email']) ?? 'User',
                  ),
                ),
            ],
            onChanged: (value) => setState(() => _assignedTo = value),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: _pickDueDate,
            icon: const Icon(Icons.event_outlined),
            label: Text(
              _dueDate == null ? 'Set due date' : 'Due ${shortDate(_dueDate)}',
            ),
          ),
          if (_dueDate != null)
            TextButton(
              onPressed: () => setState(() => _dueDate = null),
              child: const Text('Remove due date'),
            ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: _submit,
            child: Text(widget.task == null ? 'Create task' : 'Save changes'),
          ),
        ],
      ),
    );
  }

  Future<void> _pickDueDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      firstDate: DateTime(now.year - 1),
      lastDate: DateTime(now.year + 5),
      initialDate: _dueDate ?? now,
    );
    if (picked != null) setState(() => _dueDate = picked);
  }

  void _submit() {
    final title = _title.text.trim();
    if (title.isEmpty) {
      showSnack(context, 'Task is required');
      return;
    }
    Navigator.of(context).pop({
      'task': title,
      'description':
          _description.text.trim().isEmpty ? null : _description.text.trim(),
      'status': _status,
      'priority': _priority,
      'assigned_to': _assignedTo,
      'due_date': _dueDate == null ? null : _dateOnly(_dueDate!),
    });
  }

  String _dateOnly(DateTime value) {
    final year = value.year.toString().padLeft(4, '0');
    final month = value.month.toString().padLeft(2, '0');
    final day = value.day.toString().padLeft(2, '0');
    return '$year-$month-$day';
  }
}
