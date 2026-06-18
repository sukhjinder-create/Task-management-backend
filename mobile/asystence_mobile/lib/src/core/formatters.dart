import 'package:intl/intl.dart';

String shortDate(DateTime? value) {
  if (value == null) return 'No date';
  return DateFormat('MMM d').format(value.toLocal());
}

String longDateTime(DateTime? value) {
  if (value == null) return '';
  return DateFormat('MMM d, y h:mm a').format(value.toLocal());
}

String compactNumber(num? value) {
  if (value == null) return '0';
  if (value.abs() >= 1000000) return '${(value / 1000000).toStringAsFixed(1)}M';
  if (value.abs() >= 1000) return '${(value / 1000).toStringAsFixed(1)}k';
  return value.toStringAsFixed(value.truncateToDouble() == value ? 0 : 1);
}

String sentenceCase(String? value) {
  final raw = (value ?? '').replaceAll('_', ' ').trim();
  if (raw.isEmpty) return '';
  return raw[0].toUpperCase() + raw.substring(1);
}
