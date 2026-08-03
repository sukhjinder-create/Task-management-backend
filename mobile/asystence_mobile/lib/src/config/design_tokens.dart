// lib/src/config/design_tokens.dart
//
// The single source of truth for the app's visual language.
//
// Screens should not hardcode colours, spacing or radii — they read them from
// Theme.of(context) or from these tokens, so the whole app restyles (and light
// mode stays correct) from one place.

import 'package:flutter/material.dart';

/// Spacing scale. A small fixed set keeps rhythm consistent; arbitrary values
/// are what make an interface feel subtly "off".
abstract final class Insets {
  static const double xxs = 4;
  static const double xs = 8;
  static const double sm = 12;
  static const double md = 16;
  static const double lg = 20;
  static const double xl = 24;
  static const double xxl = 32;
  static const double huge = 48;
}

/// Corner radii. Larger than the previous flat 8px everywhere — softer corners
/// read as more modern and give hierarchy between surfaces and controls.
abstract final class Radii {
  static const double xs = 8;
  static const double sm = 10;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 20;
  static const double pill = 999;

  static BorderRadius get cardRadius => BorderRadius.circular(lg);
  static BorderRadius get controlRadius => BorderRadius.circular(md);
  static BorderRadius get sheetRadius =>
      const BorderRadius.vertical(top: Radius.circular(xl));
}

/// Motion. Consistent, short, and eased — long animations feel sluggish on a
/// task app people use dozens of times a day.
abstract final class Motion {
  static const Duration fast = Duration(milliseconds: 140);
  static const Duration normal = Duration(milliseconds: 220);
  static const Duration slow = Duration(milliseconds: 320);
  static const Curve easeOut = Curves.easeOutCubic;
  static const Curve easeInOut = Curves.easeInOutCubic;
}

/// Semantic status colours, tuned per brightness so they stay legible on both
/// a near-black and an off-white background.
class StatusColors {
  const StatusColors({
    required this.success,
    required this.warning,
    required this.danger,
    required this.info,
    required this.successSoft,
    required this.warningSoft,
    required this.dangerSoft,
    required this.infoSoft,
  });

  final Color success;
  final Color warning;
  final Color danger;
  final Color info;
  final Color successSoft;
  final Color warningSoft;
  final Color dangerSoft;
  final Color infoSoft;

  static const dark = StatusColors(
    success: Color(0xff4ade80),
    warning: Color(0xfffbbf24),
    danger: Color(0xfff87171),
    info: Color(0xff60a5fa),
    successSoft: Color(0x2216a34a),
    warningSoft: Color(0x22f59e0b),
    dangerSoft: Color(0x22ef4444),
    infoSoft: Color(0x223b82f6),
  );

  static const light = StatusColors(
    success: Color(0xff15803d),
    warning: Color(0xffb45309),
    danger: Color(0xffb91c1c),
    info: Color(0xff1d4ed8),
    successSoft: Color(0x1a16a34a),
    warningSoft: Color(0x1af59e0b),
    dangerSoft: Color(0x1aef4444),
    infoSoft: Color(0x1a3b82f6),
  );
}

/// The full colour set for one theme. Exposed to widgets as a ThemeExtension so
/// screens can reach semantic colours (status, elevated surfaces) that
/// ColorScheme alone doesn't model.
@immutable
class AppPalette extends ThemeExtension<AppPalette> {
  const AppPalette({
    required this.brightness,
    required this.appBg,
    required this.surface,
    required this.surfaceSoft,
    required this.surfaceStrong,
    required this.border,
    required this.borderStrong,
    required this.text,
    required this.textMuted,
    required this.textSoft,
    required this.primary,
    required this.primaryHover,
    required this.primaryContrast,
    required this.primarySoft,
    required this.status,
    required this.shadow,
  });

  final Brightness brightness;
  final Color appBg;
  final Color surface;
  final Color surfaceSoft;
  final Color surfaceStrong;
  final Color border;
  final Color borderStrong;
  final Color text;
  final Color textMuted;
  final Color textSoft;
  final Color primary;
  final Color primaryHover;
  final Color primaryContrast;

  /// Low-opacity primary, for selected states and accent backgrounds.
  final Color primarySoft;
  final StatusColors status;
  final Color shadow;

  bool get isDark => brightness == Brightness.dark;

  /// Soft shadow used sparingly for genuine elevation (sheets, menus).
  /// Dark themes get depth from surface layering instead, so this stays subtle.
  List<BoxShadow> get cardShadow => [
        BoxShadow(
          color: shadow,
          blurRadius: isDark ? 18 : 14,
          offset: const Offset(0, 4),
          spreadRadius: isDark ? -6 : -4,
        ),
      ];

  @override
  AppPalette copyWith({
    Brightness? brightness,
    Color? appBg,
    Color? surface,
    Color? surfaceSoft,
    Color? surfaceStrong,
    Color? border,
    Color? borderStrong,
    Color? text,
    Color? textMuted,
    Color? textSoft,
    Color? primary,
    Color? primaryHover,
    Color? primaryContrast,
    Color? primarySoft,
    StatusColors? status,
    Color? shadow,
  }) {
    return AppPalette(
      brightness: brightness ?? this.brightness,
      appBg: appBg ?? this.appBg,
      surface: surface ?? this.surface,
      surfaceSoft: surfaceSoft ?? this.surfaceSoft,
      surfaceStrong: surfaceStrong ?? this.surfaceStrong,
      border: border ?? this.border,
      borderStrong: borderStrong ?? this.borderStrong,
      text: text ?? this.text,
      textMuted: textMuted ?? this.textMuted,
      textSoft: textSoft ?? this.textSoft,
      primary: primary ?? this.primary,
      primaryHover: primaryHover ?? this.primaryHover,
      primaryContrast: primaryContrast ?? this.primaryContrast,
      primarySoft: primarySoft ?? this.primarySoft,
      status: status ?? this.status,
      shadow: shadow ?? this.shadow,
    );
  }

  @override
  AppPalette lerp(ThemeExtension<AppPalette>? other, double t) {
    if (other is! AppPalette) return this;
    return AppPalette(
      brightness: t < 0.5 ? brightness : other.brightness,
      appBg: Color.lerp(appBg, other.appBg, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      surfaceSoft: Color.lerp(surfaceSoft, other.surfaceSoft, t)!,
      surfaceStrong: Color.lerp(surfaceStrong, other.surfaceStrong, t)!,
      border: Color.lerp(border, other.border, t)!,
      borderStrong: Color.lerp(borderStrong, other.borderStrong, t)!,
      text: Color.lerp(text, other.text, t)!,
      textMuted: Color.lerp(textMuted, other.textMuted, t)!,
      textSoft: Color.lerp(textSoft, other.textSoft, t)!,
      primary: Color.lerp(primary, other.primary, t)!,
      primaryHover: Color.lerp(primaryHover, other.primaryHover, t)!,
      primaryContrast: Color.lerp(primaryContrast, other.primaryContrast, t)!,
      primarySoft: Color.lerp(primarySoft, other.primarySoft, t)!,
      status: t < 0.5 ? status : other.status,
      shadow: Color.lerp(shadow, other.shadow, t)!,
    );
  }
}

/// Convenience access: `context.palette.status.danger`
extension PaletteAccess on BuildContext {
  AppPalette get palette =>
      Theme.of(this).extension<AppPalette>() ?? AppPalettes.dark();
}

/// The concrete palettes.
abstract final class AppPalettes {
  /// Asystence orange — the constant across every variant.
  static const brandPrimary = Color(0xffffa500);

  /// Default dark. Near-black with warm-neutral greys rather than blue-greys,
  /// so the orange accent sits naturally instead of fighting a cool base.
  static AppPalette dark() => _dark(
        primary: brandPrimary,
        hover: const Color(0xffffb733),
        bg: const Color(0xff0a0a0b),
        surface: const Color(0xff121214),
      );

  /// Light. Deliberately a warm off-white rather than pure white or cold grey —
  /// pure white next to a saturated orange is harsh at phone brightness.
  static AppPalette light({Color primary = brandPrimary}) => AppPalette(
        brightness: Brightness.light,
        appBg: const Color(0xfffaf9f8),
        surface: const Color(0xffffffff),
        surfaceSoft: const Color(0xfff5f4f2),
        surfaceStrong: const Color(0xffeceae7),
        border: const Color(0xffe4e1dd),
        borderStrong: const Color(0xffcfcbc5),
        text: const Color(0xff1c1c1f),
        textMuted: const Color(0xff5f5f68),
        textSoft: const Color(0xff8a8a93),
        primary: primary,
        primaryHover: const Color(0xffe08e00),
        // Orange is a light colour: white text on it fails contrast, so the
        // readable pairing is near-black.
        primaryContrast: const Color(0xff1c1c1f),
        primarySoft: primary.withValues(alpha: 0.12),
        status: StatusColors.light,
        shadow: const Color(0x14000000),
      );

  static AppPalette ocean() => _dark(
        primary: const Color(0xff38bdf8),
        hover: const Color(0xff7dd3fc),
        bg: const Color(0xff06131d),
        surface: const Color(0xff0b1c29),
      );

  static AppPalette forest() => _dark(
        primary: const Color(0xff4ade80),
        hover: const Color(0xff86efac),
        bg: const Color(0xff07150d),
        surface: const Color(0xff0d2115),
      );

  static AppPalette sunset() => _dark(
        primary: const Color(0xffff7043),
        hover: const Color(0xffff9a76),
        bg: const Color(0xff170a07),
        surface: const Color(0xff24110d),
      );

  static AppPalette yellow() => _dark(
        primary: const Color(0xfffacc15),
        hover: const Color(0xfffde047),
        bg: const Color(0xff15130a),
        surface: const Color(0xff201d0d),
      );

  /// Dark variants share one construction so every accent gets the same
  /// surface layering and contrast relationships.
  static AppPalette _dark({
    required Color primary,
    required Color hover,
    required Color bg,
    required Color surface,
  }) {
    Color raise(double amount) =>
        Color.alphaBlend(Colors.white.withValues(alpha: amount), surface);

    return AppPalette(
      brightness: Brightness.dark,
      appBg: bg,
      surface: surface,
      surfaceSoft: raise(0.04),
      surfaceStrong: raise(0.09),
      border: raise(0.13),
      borderStrong: raise(0.22),
      text: const Color(0xfff5f5f6),
      textMuted: const Color(0xffa1a1ab),
      textSoft: const Color(0xff71717d),
      primary: primary,
      primaryHover: hover,
      primaryContrast: const Color(0xff0a0a0b),
      primarySoft: primary.withValues(alpha: 0.16),
      status: StatusColors.dark,
      shadow: const Color(0x66000000),
    );
  }
}
