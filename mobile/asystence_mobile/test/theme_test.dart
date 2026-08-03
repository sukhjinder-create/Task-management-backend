import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:asystence_mobile/src/config/app_theme.dart';
import 'package:asystence_mobile/src/config/design_tokens.dart';
import 'package:asystence_mobile/src/state/theme_store.dart';

/// Relative luminance contrast ratio (WCAG). 4.5:1 is the AA threshold for
/// body text; 3:1 for large text and UI components.
double _contrast(Color a, Color b) {
  double lum(Color c) {
    double ch(double v) {
      v = v / 255.0;
      return v <= 0.03928
          ? v / 12.92
          : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
    }

    return 0.2126 * ch((c.r * 255)) +
        0.7152 * ch((c.g * 255)) +
        0.0722 * ch((c.b * 255));
  }

  final l1 = lum(a), l2 = lum(b);
  final hi = l1 > l2 ? l1 : l2, lo = l1 > l2 ? l2 : l1;
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  test('every theme option resolves to a usable palette', () {
    for (final option in AppThemeOption.values) {
      for (final b in Brightness.values) {
        final p = AppTheme.paletteFor(option, b);
        final theme = AppTheme.build(p);
        expect(
          theme.extension<AppPalette>(),
          isNotNull,
          reason: '$option/$b must expose its palette to widgets',
        );
        expect(theme.scaffoldBackgroundColor, p.appBg);
        expect(theme.colorScheme.primary, p.primary);
      }
    }
  });

  test('light mode is genuinely light and dark is genuinely dark', () {
    final light = AppTheme.paletteFor(AppThemeOption.light, Brightness.dark);
    expect(
      light.brightness,
      Brightness.light,
      reason: 'explicit light choice must win over system brightness',
    );
    expect(light.appBg.computeLuminance(), greaterThan(0.7));

    final dark = AppTheme.paletteFor(AppThemeOption.dark, Brightness.light);
    expect(dark.brightness, Brightness.dark);
    expect(dark.appBg.computeLuminance(), lessThan(0.1));
  });

  test('system option follows the platform brightness', () {
    expect(
      AppTheme.paletteFor(AppThemeOption.system, Brightness.light).brightness,
      Brightness.light,
    );
    expect(
      AppTheme.paletteFor(AppThemeOption.system, Brightness.dark).brightness,
      Brightness.dark,
    );
  });

  test('body text meets WCAG AA contrast on every palette', () {
    for (final option in AppThemeOption.values) {
      final p = AppTheme.paletteFor(option, Brightness.dark);
      expect(
        _contrast(p.text, p.appBg),
        greaterThanOrEqualTo(4.5),
        reason: '$option: primary text on background',
      );
      expect(
        _contrast(p.text, p.surface),
        greaterThanOrEqualTo(4.5),
        reason: '$option: primary text on card surface',
      );
      expect(
        _contrast(p.textMuted, p.appBg),
        greaterThanOrEqualTo(3.0),
        reason: '$option: muted text must stay legible',
      );
    }
  });

  test('text on primary buttons is readable', () {
    // Orange is a light colour — white on it fails badly. This guards the
    // pairing so a future palette tweak cannot silently break button labels.
    for (final option in AppThemeOption.values) {
      final p = AppTheme.paletteFor(option, Brightness.dark);
      expect(
        _contrast(p.primaryContrast, p.primary),
        greaterThanOrEqualTo(3.0),
        reason: '$option: button label on primary fill',
      );
    }
  });

  test('brand identity is preserved across default themes', () {
    expect(AppPalettes.dark().primary, AppPalettes.brandPrimary);
    expect(AppPalettes.light().primary, AppPalettes.brandPrimary);
  });
}
