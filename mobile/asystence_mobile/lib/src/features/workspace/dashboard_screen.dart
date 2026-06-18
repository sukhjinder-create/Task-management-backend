import 'package:flutter/material.dart';

import '../../core/formatters.dart';
import '../../core/models.dart';
import '../../core/ui.dart';
import '../../state/app_scope.dart';
import 'task_detail_screen.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  late Future<JsonMap> _future;
  bool _ready = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_ready) {
      _future = _load();
      _ready = true;
    }
  }

  Future<JsonMap> _load() => AppScope.of(context).api.dashboardOverview();

  Future<void> _refresh() async {
    setState(() => _future = _load());
    await _future;
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _refresh,
      child: AsyncValueBuilder<JsonMap>(
        future: _future,
        builder: (context, data) {
          final counts =
              Map<String, dynamic>.from((data['counts'] as Map?) ?? {});
          final score =
              Map<String, dynamic>.from((data['scoreCard'] as Map?) ?? {});
          final trend =
              Map<String, dynamic>.from((data['trend'] as Map?) ?? {});
          final summary = Map<String, dynamic>.from(
            (data['executiveSummary'] as Map?) ?? {},
          );
          final overdue = ((data['topOverdue'] as List?) ?? const [])
              .whereType<Map>()
              .map((item) => TaskItem.fromJson(Map<String, dynamic>.from(item)))
              .toList();
          final health = ((data['projectHealth'] as List?) ?? const [])
              .whereType<Map>()
              .toList();

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              _ScoreHeader(score: score, trend: trend),
              const SizedBox(height: 12),
              GridView.count(
                crossAxisCount: 2,
                childAspectRatio: 1.45,
                physics: const NeverScrollableScrollPhysics(),
                shrinkWrap: true,
                mainAxisSpacing: 10,
                crossAxisSpacing: 10,
                children: [
                  _MetricCard(
                    'Projects',
                    counts['totalProjects'],
                    Icons.folder_outlined,
                  ),
                  _MetricCard(
                    'Tasks',
                    counts['totalTasks'],
                    Icons.checklist_outlined,
                  ),
                  _MetricCard(
                    'In Progress',
                    counts['inProgressTasks'],
                    Icons.timelapse_outlined,
                  ),
                  _MetricCard(
                    'Overdue',
                    counts['overdueTasks'],
                    Icons.warning_amber_outlined,
                    danger: true,
                  ),
                ],
              ),
              const SizedBox(height: 12),
              SectionCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Executive summary',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      '${summary['headline'] ?? summary['summary'] ?? data['scope']?['label'] ?? 'Workspace overview'}',
                    ),
                    if (summary.isEmpty) ...[
                      const SizedBox(height: 10),
                      JsonPreview(data: data, maxLines: 6),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 12),
              Text(
                'Overdue work',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              if (overdue.isEmpty)
                const SectionCard(
                  child: Text('No overdue tasks in this scope.'),
                )
              else
                for (final task in overdue)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: ListTile(
                      tileColor: Theme.of(context).colorScheme.surface,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                      leading: const Icon(
                        Icons.warning_amber,
                        color: Color(0xffd97706),
                      ),
                      title: Text(task.title),
                      subtitle: Text(
                        '${task.projectName ?? 'Project'} • ${shortDate(task.dueDate)}',
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (_) => TaskDetailScreen(taskId: task.id),
                        ),
                      ),
                    ),
                  ),
              const SizedBox(height: 12),
              Text(
                'Project health',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              if (health.isEmpty)
                const SectionCard(
                  child:
                      Text('Project health will appear as work accumulates.'),
                )
              else
                for (final row in health.take(6))
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: SectionCard(
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  '${row['project_name'] ?? row['name'] ?? 'Project'}',
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  '${row['completed_tasks'] ?? 0}/${row['total_tasks'] ?? 0} complete',
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                              ],
                            ),
                          ),
                          StatusChip(
                            label:
                                '${row['health'] ?? row['status'] ?? 'Tracked'}',
                            tone: ChipTone.info,
                          ),
                        ],
                      ),
                    ),
                  ),
            ],
          );
        },
      ),
    );
  }
}

class _ScoreHeader extends StatelessWidget {
  const _ScoreHeader({required this.score, required this.trend});

  final JsonMap score;
  final JsonMap trend;

  @override
  Widget build(BuildContext context) {
    final unified = readDouble(score, ['unifiedScore', 'unified_score']) ?? 0;
    final band = readString(score, ['band']) ?? 'Watch';
    final direction = readString(trend, ['direction']) ?? 'stable';
    return SectionCard(
      child: Row(
        children: [
          Container(
            width: 72,
            height: 72,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color:
                  Theme.of(context).colorScheme.primary.withValues(alpha: 0.12),
            ),
            child: Text(
              unified.toStringAsFixed(0),
              style: Theme.of(context)
                  .textTheme
                  .headlineSmall
                  ?.copyWith(fontWeight: FontWeight.w900),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Workspace score',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 4),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    StatusChip(
                      label: band,
                      tone: unified >= 75 ? ChipTone.success : ChipTone.warning,
                    ),
                    StatusChip(
                      label: sentenceCase(direction),
                      tone: ChipTone.info,
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _MetricCard extends StatelessWidget {
  const _MetricCard(this.label, this.value, this.icon, {this.danger = false});

  final String label;
  final Object? value;
  final IconData icon;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final color = danger
        ? Theme.of(context).colorScheme.error
        : Theme.of(context).colorScheme.primary;
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color),
          const Spacer(),
          Text(
            compactNumber(
              value is num ? value as num : num.tryParse('$value') ?? 0,
            ),
            style: Theme.of(context)
                .textTheme
                .headlineSmall
                ?.copyWith(fontWeight: FontWeight.w900),
          ),
          Text(label, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}
