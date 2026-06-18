import 'package:flutter/material.dart';

import '../../config/app_config.dart';
import '../../core/formatters.dart';
import '../../core/models.dart';
import '../../core/ui.dart';
import '../../state/app_scope.dart';

class LeaveScreen extends StatefulWidget {
  const LeaveScreen({super.key});

  @override
  State<LeaveScreen> createState() => _LeaveScreenState();
}

class _LeaveScreenState extends State<LeaveScreen> {
  late Future<_LeaveBundle> _future;
  bool _ready = false;
  String _filter = 'all';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_ready) {
      _future = _load();
      _ready = true;
    }
  }

  Future<_LeaveBundle> _load() async {
    final scope = AppScope.of(context);
    final user = scope.auth.user;
    final api = scope.api;
    final isAdmin = user?.isAdmin == true;
    final results = await Future.wait([
      api.leaveTypes(),
      api.leaveRequests(userId: isAdmin ? user?.id : null),
      api.leaveBalances(userId: isAdmin ? user?.id : null),
      if (isAdmin) api.leaveRequests(status: 'pending'),
    ]);
    return _LeaveBundle(
      types: results[0] as List<LeaveType>,
      mine: results[1] as List<LeaveRequest>,
      balances: results[2] as List<LeaveBalance>,
      pending: isAdmin ? results[3] as List<LeaveRequest> : const [],
    );
  }

  Future<void> _refresh() async {
    setState(() => _future = _load());
    await _future;
  }

  @override
  Widget build(BuildContext context) {
    final isAdmin = AppScope.of(context).auth.user?.isAdmin == true;
    return Scaffold(
      appBar: AppBar(title: const Text('Leave')),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: AsyncValueBuilder<_LeaveBundle>(
          future: _future,
          builder: (context, bundle) {
            final requests = _filter == 'all'
                ? bundle.mine
                : bundle.mine
                    .where((request) => request.status == _filter)
                    .toList(growable: false);
            return ListView(
              padding: const EdgeInsets.all(16),
              children: [
                if (bundle.balances.isNotEmpty) ...[
                  Text(
                    'My balances',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  SizedBox(
                    height: 108,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: bundle.balances.length,
                      separatorBuilder: (_, __) => const SizedBox(width: 8),
                      itemBuilder: (context, index) {
                        final balance = bundle.balances[index];
                        return SizedBox(
                          width: 148,
                          child: SectionCard(
                            padding: const EdgeInsets.all(12),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  balance.name,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                                const Spacer(),
                                Text(
                                  '${_number(balance.remaining)} days',
                                  style: Theme.of(context)
                                      .textTheme
                                      .titleLarge
                                      ?.copyWith(color: AppConfig.primary),
                                ),
                                Text(
                                  '${_number(balance.used)} used',
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
                  ),
                  const SizedBox(height: 16),
                ],
                FilledButton.icon(
                  onPressed: bundle.types.isEmpty
                      ? null
                      : () => _applyForLeave(bundle.types),
                  icon: const Icon(Icons.add),
                  label: const Text('Apply for leave'),
                ),
                if (isAdmin && bundle.pending.isNotEmpty) ...[
                  const SizedBox(height: 20),
                  Text(
                    'Needs review',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  for (final request in bundle.pending)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: _LeaveRequestCard(
                        request: request,
                        showRequester: true,
                        onApprove: () => _review(request, 'approved'),
                        onReject: () => _review(request, 'rejected'),
                      ),
                    ),
                ],
                const SizedBox(height: 20),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        'My requests',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                    DropdownButton<String>(
                      value: _filter,
                      items: const [
                        DropdownMenuItem(value: 'all', child: Text('All')),
                        DropdownMenuItem(
                          value: 'pending',
                          child: Text('Pending'),
                        ),
                        DropdownMenuItem(
                          value: 'approved',
                          child: Text('Approved'),
                        ),
                        DropdownMenuItem(
                          value: 'rejected',
                          child: Text('Rejected'),
                        ),
                        DropdownMenuItem(
                          value: 'cancelled',
                          child: Text('Cancelled'),
                        ),
                      ],
                      onChanged: (value) {
                        if (value != null) setState(() => _filter = value);
                      },
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                if (requests.isEmpty)
                  const SectionCard(child: Text('No leave requests found.'))
                else
                  for (final request in requests)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: _LeaveRequestCard(
                        request: request,
                        onCancel:
                            request.canCancel ? () => _cancel(request) : null,
                      ),
                    ),
              ],
            );
          },
        ),
      ),
    );
  }

  Future<void> _applyForLeave(List<LeaveType> types) async {
    final api = AppScope.of(context).api;
    final request = await showModalBottomSheet<_LeaveDraft>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => _LeaveRequestSheet(types: types),
    );
    if (request == null) return;
    try {
      await api.createLeaveRequest(
        leaveTypeId: request.leaveTypeId,
        startDate: request.startDate,
        endDate: request.endDate,
        reason: request.reason,
      );
      if (mounted) showSnack(context, 'Leave request submitted');
      await _refresh();
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    }
  }

  Future<void> _cancel(LeaveRequest request) async {
    final api = AppScope.of(context).api;
    final confirmed = await confirmAction(
      context,
      title: 'Cancel request?',
      message: 'This pending leave request will be cancelled.',
      confirmLabel: 'Cancel request',
    );
    if (!confirmed) return;
    try {
      await api.cancelLeaveRequest(request.id);
      if (mounted) showSnack(context, 'Leave request cancelled');
      await _refresh();
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    }
  }

  Future<void> _review(LeaveRequest request, String status) async {
    final api = AppScope.of(context).api;
    final note = await showJsonFormSheet(
      context,
      title: status == 'approved' ? 'Approve request' : 'Reject request',
      submitLabel: status == 'approved' ? 'Approve' : 'Reject',
      fields: const [
        TextFieldSpec(
          key: 'note',
          label: 'Review note',
          minLines: 2,
          maxLines: 4,
        ),
      ],
    );
    if (note == null) return;
    try {
      await api.reviewLeaveRequest(
        requestId: request.id,
        status: status,
        note: note['note'] as String?,
      );
      if (mounted) showSnack(context, 'Request $status');
      await _refresh();
    } catch (err) {
      if (mounted) showSnack(context, '$err');
    }
  }

  String _number(double value) {
    return value == value.roundToDouble()
        ? value.toInt().toString()
        : value.toStringAsFixed(1);
  }
}

class _LeaveRequestCard extends StatelessWidget {
  const _LeaveRequestCard({
    required this.request,
    this.showRequester = false,
    this.onCancel,
    this.onApprove,
    this.onReject,
  });

  final LeaveRequest request;
  final bool showRequester;
  final VoidCallback? onCancel;
  final VoidCallback? onApprove;
  final VoidCallback? onReject;

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
                  showRequester && request.requesterName != null
                      ? '${request.requesterName} · ${request.leaveTypeName}'
                      : request.leaveTypeName,
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              ),
              StatusChip(
                label: sentenceCase(request.status),
                tone: _statusTone(request.status),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            '${shortDate(request.startDate)} – ${shortDate(request.endDate)}'
            ' · ${request.days.toStringAsFixed(request.days % 1 == 0 ? 0 : 1)} day(s)',
          ),
          if (request.reason != null) ...[
            const SizedBox(height: 6),
            Text(
              request.reason!,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          if (request.reviewNote != null) ...[
            const SizedBox(height: 6),
            Text(
              'Review: ${request.reviewNote}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          if (onCancel != null || onApprove != null || onReject != null) ...[
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (onCancel != null)
                  TextButton.icon(
                    onPressed: onCancel,
                    icon: const Icon(Icons.close),
                    label: const Text('Cancel'),
                  ),
                if (onReject != null)
                  OutlinedButton.icon(
                    onPressed: onReject,
                    icon: const Icon(Icons.close),
                    label: const Text('Reject'),
                  ),
                if (onApprove != null)
                  FilledButton.icon(
                    onPressed: onApprove,
                    icon: const Icon(Icons.check),
                    label: const Text('Approve'),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  ChipTone _statusTone(String status) {
    return switch (status.toLowerCase()) {
      'approved' => ChipTone.success,
      'rejected' || 'cancelled' => ChipTone.danger,
      'pending' => ChipTone.warning,
      _ => ChipTone.neutral,
    };
  }
}

class _LeaveRequestSheet extends StatefulWidget {
  const _LeaveRequestSheet({required this.types});

  final List<LeaveType> types;

  @override
  State<_LeaveRequestSheet> createState() => _LeaveRequestSheetState();
}

class _LeaveRequestSheetState extends State<_LeaveRequestSheet> {
  late String _typeId = widget.types.first.id;
  DateTime? _startDate;
  DateTime? _endDate;
  final _reason = TextEditingController();

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
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
            'Apply for leave',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 16),
          DropdownButtonFormField<String>(
            initialValue: _typeId,
            decoration: const InputDecoration(labelText: 'Leave type'),
            items: [
              for (final type in widget.types)
                DropdownMenuItem(value: type.id, child: Text(type.name)),
            ],
            onChanged: (value) {
              if (value != null) setState(() => _typeId = value);
            },
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => _pickDate(start: true),
                  icon: const Icon(Icons.calendar_today_outlined),
                  label: Text(
                    _startDate == null ? 'Start date' : shortDate(_startDate),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => _pickDate(start: false),
                  icon: const Icon(Icons.event_outlined),
                  label: Text(
                    _endDate == null ? 'End date' : shortDate(_endDate),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _reason,
            minLines: 3,
            maxLines: 5,
            decoration: const InputDecoration(labelText: 'Reason'),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _submit,
            child: const Text('Submit request'),
          ),
        ],
      ),
    );
  }

  Future<void> _pickDate({required bool start}) async {
    final now = DateTime.now();
    final initial =
        start ? (_startDate ?? now) : (_endDate ?? _startDate ?? now);
    final picked = await showDatePicker(
      context: context,
      firstDate: DateTime(now.year - 1),
      lastDate: DateTime(now.year + 2),
      initialDate: initial,
    );
    if (picked == null) return;
    setState(() {
      if (start) {
        _startDate = picked;
        if (_endDate != null && _endDate!.isBefore(picked)) {
          _endDate = picked;
        }
      } else {
        _endDate = picked;
      }
    });
  }

  void _submit() {
    if (_startDate == null || _endDate == null) {
      showSnack(context, 'Select start and end dates');
      return;
    }
    if (_endDate!.isBefore(_startDate!)) {
      showSnack(context, 'End date must be after start date');
      return;
    }
    Navigator.of(context).pop(
      _LeaveDraft(
        leaveTypeId: _typeId,
        startDate: _startDate!,
        endDate: _endDate!,
        reason: _reason.text.trim().isEmpty ? null : _reason.text.trim(),
      ),
    );
  }
}

class _LeaveDraft {
  const _LeaveDraft({
    required this.leaveTypeId,
    required this.startDate,
    required this.endDate,
    this.reason,
  });

  final String leaveTypeId;
  final DateTime startDate;
  final DateTime endDate;
  final String? reason;
}

class _LeaveBundle {
  const _LeaveBundle({
    required this.types,
    required this.mine,
    required this.balances,
    required this.pending,
  });

  final List<LeaveType> types;
  final List<LeaveRequest> mine;
  final List<LeaveBalance> balances;
  final List<LeaveRequest> pending;
}
