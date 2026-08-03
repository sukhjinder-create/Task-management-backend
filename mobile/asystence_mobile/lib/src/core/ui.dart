import 'dart:convert';

import 'package:flutter/material.dart';

import '../config/design_tokens.dart';
import 'models.dart';

class SectionCard extends StatelessWidget {
  const SectionCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(Insets.md),
    this.onTap,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;

  /// When provided the whole card becomes tappable with a proper ripple,
  /// instead of screens wrapping cards in a bare GestureDetector.
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final content = Padding(padding: padding, child: child);
    return Card(
      color: theme.cardTheme.color ?? theme.colorScheme.surface,
      clipBehavior: Clip.antiAlias,
      child: onTap == null
          ? content
          : InkWell(
              onTap: onTap,
              borderRadius: Radii.cardRadius,
              child: content,
            ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.message,
    this.action,
  });

  final IconData icon;
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final palette = context.palette;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Insets.xxl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Tinted disc rather than a bare icon — reads as intentional
            // empty state instead of a missing-content error.
            Container(
              width: 64,
              height: 64,
              decoration: BoxDecoration(
                color: palette.primarySoft,
                shape: BoxShape.circle,
              ),
              child: Icon(icon, size: 28, color: scheme.primary),
            ),
            const SizedBox(height: Insets.md),
            Text(
              title,
              style: theme.textTheme.titleLarge,
              textAlign: TextAlign.center,
            ),
            if (message != null) ...[
              const SizedBox(height: Insets.xs),
              Text(
                message!,
                style: theme.textTheme.bodyMedium,
                textAlign: TextAlign.center,
              ),
            ],
            if (action != null) ...[
              const SizedBox(height: Insets.lg),
              action!,
            ],
          ],
        ),
      ),
    );
  }
}

class StatusChip extends StatelessWidget {
  const StatusChip({
    super.key,
    required this.label,
    this.tone = ChipTone.neutral,
  });

  final String label;
  final ChipTone tone;

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final status = palette.status;
    // Previously hardcoded hex values tuned for a dark background, which left
    // these chips low-contrast in light mode. The palette supplies per-
    // brightness variants instead.
    final (Color color, Color background) = switch (tone) {
      ChipTone.success => (status.success, status.successSoft),
      ChipTone.warning => (status.warning, status.warningSoft),
      ChipTone.danger => (status.danger, status.dangerSoft),
      ChipTone.info => (palette.primary, palette.primarySoft),
      ChipTone.neutral => (palette.textMuted, palette.surfaceSoft),
    };
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: Insets.xs + 2,
        vertical: Insets.xxs,
      ),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(Radii.pill),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 11.5,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.2,
        ),
      ),
    );
  }
}

enum ChipTone { neutral, success, warning, danger, info }

class JsonPreview extends StatelessWidget {
  const JsonPreview({
    super.key,
    required this.data,
    this.maxLines = 12,
  });

  final Object? data;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    const encoder = JsonEncoder.withIndent('  ');
    final text = data == null ? 'null' : encoder.convert(data);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        color: Theme.of(context)
            .colorScheme
            .surfaceContainerHighest
            .withValues(alpha: 0.55),
      ),
      child: Text(
        text,
        maxLines: maxLines,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(
          fontFamily: 'monospace',
          fontSize: 12,
          height: 1.35,
        ),
      ),
    );
  }
}

class AsyncValueBuilder<T> extends StatelessWidget {
  const AsyncValueBuilder({
    super.key,
    required this.future,
    required this.builder,
    this.empty,
  });

  final Future<T> future;
  final Widget Function(BuildContext context, T value) builder;
  final Widget? empty;

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<T>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          final err = snapshot.error;
          final message = err is ApiException ? err.message : '$err';
          return EmptyState(
            icon: Icons.error_outline,
            title: 'Could not load',
            message: message,
          );
        }
        if (!snapshot.hasData) {
          return empty ??
              const EmptyState(
                icon: Icons.inbox_outlined,
                title: 'Nothing here yet',
              );
        }
        return builder(context, snapshot.data as T);
      },
    );
  }
}

Future<bool> confirmAction(
  BuildContext context, {
  required String title,
  required String message,
  String confirmLabel = 'Confirm',
}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return result == true;
}

void showSnack(BuildContext context, String message) {
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
}

class TextFieldSpec {
  const TextFieldSpec({
    required this.key,
    required this.label,
    this.initialValue,
    this.minLines = 1,
    this.maxLines = 1,
    this.keyboardType,
    this.isRequired = false,
  });

  final String key;
  final String label;
  final String? initialValue;
  final int minLines;
  final int maxLines;
  final TextInputType? keyboardType;
  final bool isRequired;
}

Future<JsonMap?> showJsonFormSheet(
  BuildContext context, {
  required String title,
  required List<TextFieldSpec> fields,
  String submitLabel = 'Save',
}) {
  return showModalBottomSheet<JsonMap>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (context) => _JsonFormSheet(
      title: title,
      fields: fields,
      submitLabel: submitLabel,
    ),
  );
}

class _JsonFormSheet extends StatefulWidget {
  const _JsonFormSheet({
    required this.title,
    required this.fields,
    required this.submitLabel,
  });

  final String title;
  final List<TextFieldSpec> fields;
  final String submitLabel;

  @override
  State<_JsonFormSheet> createState() => _JsonFormSheetState();
}

class _JsonFormSheetState extends State<_JsonFormSheet> {
  late final Map<String, TextEditingController> _controllers = {
    for (final field in widget.fields)
      field.key: TextEditingController(text: field.initialValue),
  };

  @override
  void dispose() {
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      child: ListView(
        shrinkWrap: true,
        children: [
          Text(widget.title, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 16),
          for (final field in widget.fields) ...[
            TextField(
              controller: _controllers[field.key],
              minLines: field.minLines,
              maxLines: field.maxLines,
              keyboardType: field.keyboardType,
              decoration: InputDecoration(
                labelText: field.isRequired ? '${field.label} *' : field.label,
              ),
            ),
            const SizedBox(height: 12),
          ],
          FilledButton(
            onPressed: () {
              final payload = <String, dynamic>{};
              for (final field in widget.fields) {
                final value = _controllers[field.key]?.text.trim() ?? '';
                if (field.isRequired && value.isEmpty) {
                  showSnack(context, '${field.label} is required');
                  return;
                }
                payload[field.key] = value.isEmpty ? null : value;
              }
              Navigator.pop(context, payload);
            },
            child: Text(widget.submitLabel),
          ),
        ],
      ),
    );
  }
}
